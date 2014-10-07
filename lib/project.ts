///<reference path='../definitions/ref.d.ts'/>

import gutil = require('gulp-util');
import path = require('path');
import stream = require('stream');
import fs = require('fs'); // Only used for readonly access
import sourcemapApply = require('vinyl-sourcemaps-apply');
import host = require('./host');

export interface Map<T> {
	[key: string]: T;
}
export interface FileData {
	file?: gutil.File;
	content: string;
}

export class Project {
	/**
	 * Files from the previous compilation.
	 * Used to find the differences with the previous compilation, to make the new compilation faster.
	 */
	//previousFiles: Map<FileData> = {};
	/**
	 * The files in the current compilation.
	 * This Map only contains the files in the project, not external files. Those are in Project#additionalFiles.
	 * The file property of the FileData objects in this Map are set.
	 */
	currentFiles: Map<FileData> = {};
	/**
	 * External files of the current compilation.
	 * When a file is imported by or referenced from another file, and the file is not one of the input files, it
	 * is added to this Map. The file property of the FileData objects in this Map are not set.
	 */
	additionalFiles: Map<FileData> = {};
	
	/**
	 * Whether there should not be loaded external files to the project.
	 * Example:
	 *   In the lib directory you have .ts files.
	 *   In the definitions directory you have the .d.ts files.
	 *   If you turn this option on, you should add in your gulp file the definitions directory as an input source.
	 * Advantage:
	 * - Faster builds
	 * Disadvantage:
	 * - If you forget some directory, your compile will fail.
	 */
	private noExternalResolve: boolean;
	/**
	 * Sort output based on <reference> tags.
	 * tsc does this when you pass the --out parameter.
	 */
	private sortOutput: boolean;
	
	/**
	 * The version number of the compilation.
	 * This number is increased for every compilation in the same gulp session.
	 * Used for incremental builds.
	 */
	// version: number = 0;
	
	options: ts.CompilerOptions;
	host: host.Host;
	program: ts.Program;

	constructor(options: ts.CompilerOptions, noExternalResolve: boolean, sortOutput: boolean) {
		this.options = options;
		
		this.noExternalResolve = noExternalResolve;
		this.sortOutput = sortOutput;
	}
	
	getCurrentFilenames(): string[] {
		var result: string[] = [];
		
		for (var i in this.currentFiles) {
			if (this.currentFiles.hasOwnProperty(i)) {
				result.push(this.currentFiles[i].file.path);
			}
		}
		
		return result;
	}/**
	 * Resets the compiler.
	 * The compiler needs to be reset for incremental builds.
	 */
	reset() {
		this.currentFiles = {};
		this.additionalFiles = {};
		
		//this.version++;
	}
	/**
	 * Adds a file to the project.
	 */
	addFile(file: gutil.File) {
		this.currentFiles[this.normalizePath(file.path)] = this.getFileDataFromGulpFile(file);
	}
	
	private getOriginalName(filename: string): string {
		return filename.replace(/(\.d\.ts|\.js|\.js.map)$/, '.ts')
	}
	private getError(info: ts.Diagnostic) {
		var filename = this.getOriginalName(info.file.filename)
		var file = this.currentFiles[filename];
		
		if (file) {
			filename = path.relative(file.file.cwd, info.file.filename);
		} else {
			filename = info.file.filename;
		}
		
		var startPos = info.file.getLineAndCharacterFromPosition(info.start);
		
		var err = new Error();
		err.name = 'TypeScript error';
		err.message = gutil.colors.red(filename + '(' + (startPos.line + 1) + ',' + (startPos.character + 1) + '): ') + info.code + ' ' + info.messageText;
		
		return err;
	}
	
	/**
	 * Compiles the input files
	 */
	compile(jsStream: stream.Readable, declStream: stream.Readable, errorCallback: (err: Error) => void) {
		this.host = new host.Host(this.currentFiles[0] ? this.currentFiles[0].file.cwd : '', this.currentFiles);
		
		// Creating a program compiles the sources
		this.program = ts.createProgram(this.getCurrentFilenames(), this.options, this.host);
		
		var errors = this.program.getDiagnostics();
        
		if (!errors.length) {
			// If there are no syntax errors, check types
			var checker = this.program.getTypeChecker(true);
			
			var semanticErrors = checker.getDiagnostics();
			
            var emitErrors = checker.emitFiles().errors;
            
            errors = semanticErrors.concat(emitErrors);
        }
		
		for (var i = 0; i < errors.length; i++) {
			errorCallback(this.getError(errors[i]));
		}
		
		var outputJS: gutil.File[] = [];
		var sourcemaps: { [ filename: string ]: string } = {};
		
		for (var filename in this.host.output) {
			if (!this.host.output.hasOwnProperty(filename)) continue;
			
			var originalName = this.getOriginalName(filename);
			var original: FileData = this.currentFiles[originalName];
			
			if (!original) continue;
			
			var data: string = this.host.output[filename];
			
			if (filename.substr(-3) === '.js') {
				var file = new gutil.File({
					path: filename,
					contents: new Buffer(this.removeSourceMapComment(data)),
					cwd: original.file.cwd,
					base: original.file.base
				});

				if (original.file.sourceMap) file.sourceMap = original.file.sourceMap;
				outputJS.push(file);
			} else if (filename.substr(-5) === '.d.ts') {
				var file = new gutil.File({
					path: filename,
					contents: new Buffer(this.removeSourceMapComment(data)),
					cwd: original.file.cwd,
					base: original.file.base
				});
				
				declStream.push(file);
			} else if (filename.substr(-4) === '.map') {
				sourcemaps[filename] = data;
			}
		}
		
		var emit = (originalName: string, file: gutil.File) => {
			var map = sourcemaps[originalName];

			if (map) sourcemapApply(file, map);

			jsStream.push(file);
		};
		
		if (this.sortOutput) {
			var done: { [ filename: string] : boolean } = {};

			var sortedEmit = (originalName: string, file: gutil.File) => {
				if (done[originalName]) return;
				done[originalName] = true;

				var inputFile = this.currentFiles[originalName];
				var tsFile = this.program.getSourceFile(originalName);
				var references = tsFile.referencedFiles.map(file => file.filename);
				
				for (var j = 0; j < outputJS.length; ++j) {
					var other = outputJS[j];
					var otherName = this.getOriginalName(other.path);

					if (references.indexOf(otherName) !== -1) {
						sortedEmit(otherName, other);
					}
				}

				emit(originalName, file);
			};

			for (var i = 0; i < outputJS.length; ++i) {
				var file = outputJS[i];
				var originalName = this.getOriginalName(file.path);
				sortedEmit(originalName, file);
			}
		} else {
			for (var i = 0; i < outputJS.length; ++i) {
				var file = outputJS[i];
				var originalName = this.getOriginalName(file.path);
				emit(originalName, file);
			}
		}
	}
	
	private getFileDataFromGulpFile(file: gutil.File): FileData {
		var str = file.contents.toString('utf8');
		
		var data = this.getFileData(this.normalizePath(file.path), str);
		data.file = file;
		
		return data;
	}
	
	private getFileData(filename: string, content: string): FileData {
		return {
			content: content
		};
	}
	
	private removeSourceMapComment(content: string): string {
		// By default the TypeScript automaticly inserts a source map comment.
		// This should be removed because gulp-sourcemaps takes care of that.
		// The comment is always on the last line, so it's easy to remove it
		// (But the last line also ends with a \n, so we need to look for the \n before the other)
		var index = content.lastIndexOf('\n', content.length - 2);
		return content.substring(0, index) + '\n';
	}

	normalizePath(path: string) {
		// Switch to forward slashes
		path = path.replace(/\\/g, '/');

		return path;
	}

	// IReferenceResolverHost
	/*getScriptSnapshot(filename: string): typescript.IScriptSnapshot {
		filename = this.normalizePath(filename);
		if (this.currentFiles[filename]) {
			return this.currentFiles[filename].scriptSnapshot;
		} else if (this.additionalFiles[filename]) {
			return this.additionalFiles[filename].scriptSnapshot;
		} else if (!this.noExternalResolve) {
			var data: string = fs.readFileSync(filename).toString('utf8');
			this.additionalFiles[filename] = this.getFileData(filename, data);
			return this.additionalFiles[filename].scriptSnapshot;
		}
	}
	resolveRelativePath(path: string, directory: string): string {
		var unQuotedPath = typescript.stripStartAndEndQuotes(path);
		var normalizedPath: string;

		if (typescript.isRooted(unQuotedPath) || !directory) {
			normalizedPath = unQuotedPath;
		} else {
			normalizedPath = typescript.IOUtils.combine(directory, unQuotedPath);
		}

		// get the absolute path
		normalizedPath = this.resolvePath(normalizedPath);

		// Switch to forward slashes
		normalizedPath = typescript.switchToForwardSlashes(normalizedPath);

		return normalizedPath;
	}
	fileExists(path: string): boolean {
		if (this.currentFiles[path] || this.additionalFiles[path]) {
			return true;
		} else if (!this.noExternalResolve) {
			return typescript.IO.fileExists(path);
		} else {
			return false;
		}
	}
	getParentDirectory(path: string): string {
		return typescript.IO.dirName(path);
	}
	directoryExists(path: string): boolean {
		var newPath = path;
		if (newPath.substr(newPath.length - 1) != '/') {
			newPath += '/';
		}
		
		for (var filename in this.currentFiles) {
			if (!Object.prototype.hasOwnProperty.call(this.currentFiles, filename)) {
				continue;
			}
			
			if (filename.length > newPath.length) {
				if (filename.substring(0, newPath.length) == newPath) {
					return true;
				}
			}
		}
		for (var filename in this.additionalFiles) {
			if (!Object.prototype.hasOwnProperty.call(this.additionalFiles, filename)) {
				continue;
			}
			
			if (filename.length > newPath.length) {
				if (filename.substring(0, newPath.length) == newPath) {
					return true;
				}
			}
		}
		
		if (this.noExternalResolve) {
			return false;
		} else {
			return typescript.IO.directoryExists(path);
		}
	}
	resolvePath(path: string): string {
		return typescript.IO.resolvePath(path);
	}*/
}
