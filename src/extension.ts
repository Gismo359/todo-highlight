import path = require('path');
import * as vscode from 'vscode';
import {
	Range,
	TextEditor,
	ExtensionContext,
	DecorationOptions,
	TextEditorDecorationType,
	DecorationRenderOptions
} from 'vscode';

interface Dictionary<T> {
	[Key: string]: T;
}

interface AnnotationOptions extends DecorationRenderOptions {
	name: string;
	pattern: string;
}

interface Language {
	filePattern: string;
	lineComments: Array<string>;
	blockComments: Array<string>;
	skippedBlocks: Array<string>;
}

class DecorationType {
	constructor(name: string, pattern: string, type: TextEditorDecorationType) {
		this.name = name;
		this.pattern = pattern;
		this.type = type;
		this.options = [];
	}

	name: string;
	pattern: string;
	type: TextEditorDecorationType;
	options: Array<DecorationOptions> = [];
}

class GlobalState {
	private static instance: GlobalState;

	private constructor(languages: Array<Language>, decorations: Dictionary<DecorationType>) {
		this.languages = languages;
		this.annotations = decorations;
	}

	public static getInstance(): GlobalState {
		return GlobalState.instance;
	}

	public static reload() {
		const configuration = vscode.workspace.getConfiguration("todo");
		const annotationOptions = configuration.get<Array<AnnotationOptions>>("annotations");
		const languages = configuration.get<Array<Language>>("languages");

		if (annotationOptions === undefined || languages === undefined) {
			return;
		}

		if (GlobalState.instance !== undefined) {
			for (const annotation of Object.values(GlobalState.instance.annotations)) {
				annotation.type.dispose();
			}
		}

		let decorations: Dictionary<DecorationType> = {};
		for (const annotation of annotationOptions) {
			const decorationType = vscode.window.createTextEditorDecorationType(annotation);
			decorations[annotation.name] = new DecorationType(annotation.name, annotation.pattern, decorationType);
		}

		GlobalState.instance = new GlobalState(languages, decorations);

		decorateActiveEditor();
	}

	public languages: Array<Language>;
	public annotations: Dictionary<DecorationType>;
}

function getAnnotationRegex(info: Language): RegExp {
	// TODO@Daniel:
	//   Add language-specific annotations
	const patterns = Object.values(GlobalState.getInstance().annotations).map(t => `(?<${t.name}>${t.pattern})`);
	const pattern = patterns.join("|");
	return new RegExp(pattern, "g");
}

function getCommentRegex(info: Language): RegExp {
	const lineComments = info.lineComments.join("|");
	const blockComments = info.blockComments.join("|");
	const skippedBlocks = info.skippedBlocks.join("|");
	const pattern = [
		`(?<body>${lineComments}|${blockComments})`,
		`(?:${skippedBlocks})`
	].join("|");
	return new RegExp(pattern, "g");
}

function decorate(editor: TextEditor) {
	const document = editor.document;

	const globalState = GlobalState.getInstance();

	for (const info of globalState.languages) {
		const extension = path.basename(document.fileName);
		const regex = new RegExp(info.filePattern);
		if (!regex.test(extension)) {
			continue;
		}

		const commentRegex = getCommentRegex(info);
		const annotationRegex = getAnnotationRegex(info);

		const text = document.getText();

		for (const value of Object.values(globalState.annotations)) {
			value.options = [];
		}

		let commentMatch;
		while ((commentMatch = commentRegex.exec(text)) !== null) {
			const commentBody = commentMatch.groups?.body;
			if (commentBody === undefined) {
				continue;
			}

			// NOTE@Daniel:
			//   Empty matches do not increment lastIndex for some dumb reason
			if (commentBody === '') {
				commentRegex.lastIndex++;
			}

			const commentStart = commentMatch.index;

			let annotationMatch;
			while ((annotationMatch = annotationRegex.exec(commentBody)) !== null) {
				const annotationGroups = annotationMatch.groups;
				if (annotationGroups === undefined) {
					continue;
				}

				for (const [key, value] of Object.entries(annotationGroups)) {
					if (value === undefined) {
						continue;
					}

					const annotationStart = commentStart + annotationMatch.index;
					const annotationStop = commentStart + annotationMatch.index + annotationMatch[0].length;

					const startPos = document.positionAt(annotationStart);
					const stopPos = document.positionAt(annotationStop);
					const decoration = { range: new Range(startPos, stopPos) };

					globalState.annotations[key].options.push(decoration);
				}
			}
		}

		for (const result of Object.values(globalState.annotations)) {
			editor.setDecorations(result.type, result.options);
		}
	}
}

function decorateActiveEditor() {
	for (const editor of vscode.window.visibleTextEditors) {
		if (editor !== undefined && editor !== null) {
			decorate(editor);
		}
	}
}

export function activate(context: ExtensionContext) {
	GlobalState.reload();

	const onTextChangedCommand = vscode.workspace.onDidChangeTextDocument(decorateActiveEditor);
	const onTextEditorChanged = vscode.window.onDidChangeActiveTextEditor(decorateActiveEditor);
	const onConfigurationChanged = vscode.workspace.onDidChangeConfiguration(GlobalState.reload);

	context.subscriptions.push(onTextChangedCommand);
	context.subscriptions.push(onTextEditorChanged);
	context.subscriptions.push(onConfigurationChanged);
}
