/* eslint-disable  @typescript-eslint/naming-convention */
interface AppendSessionOutputMessage {
	result: string;
}
interface CloseWindowMessage {
	win: number;
}
interface DisconnectMessage {
	message: string;
}
interface EchoInputMessage {
	input: string;
}
interface GetHelpInformationMessage {
	line: string;
	pos: number;
}
interface GotoWindowMessage {
	win: number;
}
interface HadErrorMessage {
	dmx: number;
	error: number;
}
interface InterpreterStatusMessage {
	CompactCount: number;
	DQ: number;
	GarbageCount: number;
	IO: number;
	ML: number;
	NumThreads: number;
	SI: number;
	TID: number;
	TRAP: number;
	WA: number;
}
interface IdentifyMessage {
	Port: number;
	IPAddress: string;
	Vendor: string;
	Language: string;
	version: string;
	Machine: string;
	arch: string;
	Project: string;
	Process: string;
	User: string;
	pid: number,
	token: string;
	date: string;
	platform: string;
}
interface InternalErrorMessage {
	error: number;
	error_text: string;
	dmx: string;
	message: string;
}
interface NotificationMessage {
	message: string;
	token: number;
}
interface OpenWindowMessage {
	currentRow: number;
	debugger: number;
	entityType: number;
	filename: string;
	monitor: number[];
	name: string;
	offset: number;
	readOnly: number;
	size: number;
	stop: number[];
	text: string[];
	tid: number;
	tname: string;
	token: number;
	trace: number[];
}
interface OptionsDialogMessage {
	options: string[];
	text: string;
	title: string;
	token: number;
	type: number;
}
interface ReplyClearTraceStopMonitorMessage {
	monitors: number;
	stops: number;
	token: number;
	traces: number;
}
interface ReplyFormatCodeMessage {
	win: number;
	text: string[];
}
interface ReplyGetAutocompleteMessage {
	options: string[];
	skip: number;
	token: number;
}
interface ReplyGetConfigurationMessage {
	configurations: {
		name: string;
		value: string;
	}[];
}
interface ReplyGetHelpInformationMessage {
	url: string;
}
interface ReplyGetLanguageBarMessage {
	entries: {
		name: string;
		avchar: string;
		helptext: string;
	}[];
}
interface ReplyGetLogMessage {
	result: string[];
}
interface ReplyGetSIStackMessage {
	stack: {
		description: string;
	}[];
	tid: number;
}
interface ReplyGetSyntaxInformationMessage {
	idioms: string[];
}
interface ReplyGetThreadsMessage {
	threads: {
		description: string;
		state: string;
		flags: string;
		Treq: string;
		tid: number;
	}[];
}
interface ReplySaveChangesMessage {
	err: number;
	win: number;
}
interface ReplyTreeListMessage {
	nodeId: number;
	nodeIds: number[];
	names: string[],
    classes: number[];
	err: string;
}
interface SetHighlightLineMessage {
	line: number;
	win: number;
}
interface SetPromptTypeMessage {
	type: number;
}
interface ShowHTMLMessage {
	title: string;
	html: string;
}
interface StatusOutputMessage {
	text: string;
	flags: number;
}
interface StringDialogMessage {
	defaultValue: string;
	initialValue: string;
	text: string;
	title: string;
	token: number;
}
interface SysErrorMessage {
	text: string;
	stack: string;
}
interface TaskDialogMessage {
	buttonText: string[];
	footer: string;
	options: string[];
	subtext: string;
	text: string;
	title: string;
	token: number;
}
interface UnknownCommandMessage {
	name: string;
}
interface UpdateDisplayNameMessage {
	displayName: string;
}
interface ValueTipMessage {
	class: number;
	startCol: number;
	endCol: number;
	token: number;
	tip: string[];
}
interface WindowTypeChangedMessage {
	tracer: number;
	win: number;
}
interface RideMessage {
	length: 2;
	0: string;
	1: AppendSessionOutputMessage | CloseWindowMessage | DisconnectMessage | EchoInputMessage |
		GetHelpInformationMessage | GotoWindowMessage | HadErrorMessage |
		IdentifyMessage | InterpreterStatusMessage | InternalErrorMessage |
		NotificationMessage | OpenWindowMessage |
		OptionsDialogMessage | ReplyClearTraceStopMonitorMessage | ReplyFormatCodeMessage |
		ReplyGetAutocompleteMessage | ReplyGetConfigurationMessage |
		ReplyGetHelpInformationMessage | ReplyGetLanguageBarMessage | ReplyGetLogMessage |
		ReplyGetSIStackMessage | ReplyGetSyntaxInformationMessage | ReplyGetThreadsMessage |
		ReplySaveChangesMessage | ReplyTreeListMessage | SetHighlightLineMessage |
		StringDialogMessage | TaskDialogMessage |
		SetPromptTypeMessage | ShowHTMLMessage | StatusOutputMessage |
		SysErrorMessage | UnknownCommandMessage | UpdateDisplayNameMessage |
		ValueTipMessage | WindowTypeChangedMessage;
}
