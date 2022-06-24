import * as vscode from 'vscode';
import {
	Range,
	TextEditor,
	ExtensionContext,
	DecorationOptions,
	TextEditorDecorationType,
	DecorationRenderOptions,
	TextDocument,
	TextLine,
	MarkdownString,
	Position
} from 'vscode';

interface Dictionary<T> {
	[Key: string]: T;
}

const KNOWN_MACROS: Dictionary<RegExp> = {
	"{email}": /[\w.]+@[\w]+\.[\w]+/,
	"{name}": /[\w]+/,
	"{date}": /{day}[-/.]{month}[-/.]{year}/,
	"{day}": /\d{2}/,
	"{month}": /\d{2}/,
	"{year}": /\d{4}/
};

interface AnnotationRenderOptions extends DecorationRenderOptions {
	name: string;
	pattern: string;
	isMarkdown?: boolean;
	breakAfterInline?: boolean;
}

interface Language {
	languageIds: string[];
	prefixes: string[];
	combinedAnnotationRegex: RegExp;
}

class DecorationType {
	constructor(
		public name: string,
		public pattern: string,
		public type: TextEditorDecorationType,
		public isMarkdown?: boolean,
		public breakAfterInline?: boolean
	) {
		this.options = [];
	}

	options: DecorationOptions[] = [];
}

class AnnotationMatch {
	constructor(
		public text: string,
		public lineIdx: number,
		public startIdx: number,
		public stopIdx: number,
		public prefixText: string,
		public prefixStartIdx: number,
		public prefixStopIdx: number,
		public decorationType: DecorationType
	) {
	}
};

class GlobalState {
	private static instance: GlobalState;

	private constructor(
		public languages: Language[],
		public annotations: Dictionary<DecorationType>
	) { }

	private static getAnnotationRegex(info: Language): RegExp {
		const globalState = GlobalState.getInstance();
		const annotations = globalState.annotations;

		// TODO@Daniel:
		//   Add language-specific annotations
		const patterns = Object.values(annotations).map(t => `(?<${t.name}>${t.pattern})`);
		const pattern = patterns.join("|");
		return new RegExp(pattern, "g");
	}

	public static getInstance(): GlobalState {
		return GlobalState.instance;
	}

	public static reload() {
		const configuration = vscode.workspace.getConfiguration("todo");
		const annotationOptions = configuration.get<AnnotationRenderOptions[]>("annotations");
		const languages = configuration.get<Language[]>("languages");

		if (annotationOptions === undefined || languages === undefined) {
			return;
		}

		if (GlobalState.instance !== undefined) {
			for (const annotation of Object.values(GlobalState.instance.annotations)) {
				annotation.type.dispose();
			}
		}

		let annotations: Dictionary<DecorationType> = {};
		for (const options of annotationOptions) {
			const decorationType = vscode.window.createTextEditorDecorationType(options);
			annotations[options.name] = new DecorationType(
				options.name,
				options.pattern,
				decorationType,
				options.isMarkdown,
				options.breakAfterInline
			);
		}

		GlobalState.instance = new GlobalState(languages, annotations);

		for (const language of languages) {
			language.combinedAnnotationRegex = GlobalState.getAnnotationRegex(language);
		}

		decorateVisibleEditors();
	}
}

function handleAnnotation(
	document: TextDocument,
	info: Language,
	matches: AnnotationMatch[]
): number {
	const decorationOptions: DecorationOptions[] = [];
	const markdownLines: string[] = [];
	const match: AnnotationMatch = matches.pop()!;

	let markdownOffset: number | null = null;
	let nextMatch: AnnotationMatch | undefined = matches.at(-1);
	let lineIdx: number;
	for (lineIdx = match.lineIdx; lineIdx < document.lineCount; lineIdx++) {
		const line: TextLine = document.lineAt(lineIdx);
		const lineText: string = line.text;
		if (lineText.substring(match.prefixStartIdx, match.prefixStopIdx) !== match.prefixText) {
			break;
		}

		const matchIdx: number = lineText.substring(match.prefixStopIdx).search(/\S/);
		const contentIdx: number = match.prefixStopIdx + matchIdx;
		if (matchIdx === -1) {
			markdownLines.push("");
			continue;
		}

		let shouldBreak: boolean;
		if (lineIdx === match.lineIdx) {
			shouldBreak = contentIdx < match.startIdx;
		} else {
			shouldBreak = contentIdx <= match.startIdx;
		}

		if (shouldBreak) {
			break;
		}

		if (lineIdx === match.lineIdx + 1) {
			if (match.decorationType.breakAfterInline && markdownLines.length) {
				break;
			}
			markdownOffset = contentIdx - match.startIdx;
		}

		if (nextMatch !== undefined && lineIdx === nextMatch.lineIdx) {
			lineIdx += handleAnnotation(document, info, matches);

			nextMatch = matches.at(-1);
			markdownLines.push("");
			continue;
		}

		if (lineIdx === match.lineIdx) {
			const firstLineText = lineText.substring(match.stopIdx);
			if (firstLineText.trim()) {
				markdownLines.push(firstLineText);
			}
		} else {
			markdownLines.push(lineText.substring(match.startIdx + markdownOffset!));
		}

		const decoration: DecorationOptions = {
			range: line.range.with(new Position(lineIdx, contentIdx))
		};

		decorationOptions.push(decoration);
	}

	let markdownString: MarkdownString;
	if (match.decorationType.isMarkdown) {
		markdownString = new MarkdownString(markdownLines.join("\n"));
	}
	for (const decorationOption of decorationOptions) {
		if (match.decorationType.isMarkdown) {
			decorationOption.hoverMessage = markdownString!;
			decorationOption.hoverMessage.isTrusted = true;
			decorationOption.hoverMessage.supportThemeIcons = true;
			decorationOption.hoverMessage.supportHtml = true;
		}

		match.decorationType.options.push(decorationOption);
	}

	return lineIdx - match.lineIdx - 1;
}

function findAnnotations(document: TextDocument, info: Language) {
	const text = document.getText();
	const globalState = GlobalState.getInstance();
	const annotations = globalState.annotations;

	const regex = info.combinedAnnotationRegex;
	if (regex === undefined) {
		return;
	}

	const matches: AnnotationMatch[] = [];
	let match;
	while ((match = regex.exec(text)) !== null) {
		const groups = match.groups;
		if (groups === undefined) {
			continue;
		}

		for (const [key, annotation] of Object.entries(annotations)) {
			const value = groups[key];
			if (value === undefined) {
				continue;
			}

			// NOTE@Daniel:
			//   Empty matches do not increment lastIndex for some dumb reason
			if (value === '') {
				regex.lastIndex++;
				continue;
			}

			const annotationStart = match.index;
			const annotationStop = match.index + match[0].length;
			const startPosition = document.positionAt(annotationStart);
			const stopPosition = document.positionAt(annotationStop);
			if (startPosition.line !== stopPosition.line) {
				continue;
			}

			const line: TextLine = document.lineAt(startPosition.line);
			const textBefore: string = document.getText(new Range(line.range.start, startPosition));

			let prefixText: string | null = null;
			let prefixStartIdx: number | null = null;
			let prefixStopIdx: number | null = null;
			for (const prefix of info.prefixes) {
				const index = textBefore.lastIndexOf(prefix);
				if (index === -1) {
					continue;
				}

				if (textBefore.substring(index + prefix.length).trim()) {
					continue;
				}

				prefixText = prefix;
				prefixStartIdx = index;
				prefixStopIdx = index + prefix.length;

				break;
			}

			if (prefixText === null || prefixStartIdx === null || prefixStopIdx === null) {
				continue;
			}

			const lineOffset: number = document.offsetAt(line.range.start);
			matches.push(
				new AnnotationMatch(
					value,
					line.lineNumber,
					annotationStart - lineOffset,
					annotationStop - lineOffset,
					prefixText,
					prefixStartIdx,
					prefixStopIdx,
					annotation
				)
			);
		}
	}

	const reverseMatches = matches.reverse();
	while (reverseMatches.length) {
		handleAnnotation(document, info, reverseMatches);
	}
}

function decorate(editor: TextEditor) {
	const document = editor.document;
	const globalState = GlobalState.getInstance();

	for (const value of Object.values(globalState.annotations)) {
		value.options = [];
	}

	for (const info of globalState.languages) {
		if (!info.languageIds.includes(document.languageId)) {
			continue;
		}

		findAnnotations(document, info);
	}

	for (const result of Object.values(globalState.annotations)) {
		editor.setDecorations(result.type, result.options);
	}
}

function decorateVisibleEditors() {
	for (const editor of vscode.window.visibleTextEditors) {
		if (editor !== undefined && editor !== null) {
			decorate(editor);
		}
	}
}

export function activate(context: ExtensionContext) {
	GlobalState.reload();

	const onTextChangedCommand = vscode.workspace.onDidChangeTextDocument(decorateVisibleEditors);
	const onTextEditorChanged = vscode.window.onDidChangeActiveTextEditor(decorateVisibleEditors);
	const onConfigurationChanged = vscode.workspace.onDidChangeConfiguration(GlobalState.reload);

	context.subscriptions.push(onTextChangedCommand);
	context.subscriptions.push(onTextEditorChanged);
	context.subscriptions.push(onConfigurationChanged);
}
