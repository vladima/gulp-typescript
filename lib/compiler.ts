import ts = require('typescript');
import gutil = require('gulp-util');
import tsApi = require('./tsApi');
import input = require('./input');
import output = require('./output');
import host = require('./host');
import project = require('./project');
import filter = require('./filter');


export interface ICompiler {
	prepare(_project: project.Project): void;
	inputFile(file: input.File);
	inputDone();
}

/**
 * Compiles a whole project, with full type checking
 */
export class ProjectCompiler implements ICompiler {
	host: host.Host;
	project: project.Project;
	program: ts.Program;

	prepare(_project: project.Project) {
		this.project = _project;
	}

	inputFile(file: input.File) { }

	inputDone() {
		if (!this.project.input.firstSourceFile) {
			this.project.output.finish();
			return;
		}

		if (!this.project.input.isChanged(true)) {
			// Re-use old output
			const old = this.project.previousOutput;

			for (const error of old.errors) {
				this.project.output.error(error);
			}

			for (const fileName of Object.keys(old.files)) {
				const file = old.files[fileName];
				this.project.output.write(file.fileName + '.js', file.content[output.OutputFileKind.JavaScript]);
				this.project.output.write(file.fileName + '.js.map', file.content[output.OutputFileKind.SourceMap]);
				if (file.content[output.OutputFileKind.Definitions] !== undefined) {
					this.project.output.write(file.fileName + '.d.ts', file.content[output.OutputFileKind.Definitions]);
				}
			}

			return;
		}

		this.host = new host.Host(this.project.typescript, this.project.currentDirectory, this.project.input, !this.project.noExternalResolve);

		let rootFilenames: string[] = this.project.input.getFileNames(true);

		if (this.project.filterSettings !== undefined) {
			let _filter = new filter.Filter(this.project, this.project.filterSettings);
			rootFilenames = rootFilenames.filter((fileName) => _filter.match(fileName));
		}

		// Creating a program to compile the sources
		this.program = this.project.typescript.createProgram(rootFilenames, this.project.options, this.host);

		const errors = tsApi.getDiagnosticsAndEmit(this.program);

		for (let i = 0; i < errors.length; i++) {
			this.project.output.diagnostic(errors[i]);
		}

		var outputJS: gutil.File[] = [];
		var sourcemaps: { [ filename: string ]: string } = {};

		for (const fileName in this.host.output) {
			if (!this.host.output.hasOwnProperty(fileName)) continue;

			this.project.output.write(fileName, this.host.output[fileName]);
		}

		this.project.output.finish();
	}
}

// TODO: file-based compiler
