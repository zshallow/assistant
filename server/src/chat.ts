import {Message, type MessageId} from "./message";
import * as openrouter from "./provider/openrouter";
import * as macros from "./macros";

export type ChatId = string;

export type ChatSettings = {
	temperature: number;
	topP: number;
	systemPrompt: string;
	color: "none" | "red" | "green" | "yellow" | "blue" | "orange" | "purple";
} & ChatSettingsProvider;

export type ChatSettingsProvider = {
	provider: "openrouter";
	model: `${string}/${string}`;
};

export type ChatHead = {
	id: string;
	name: string;
	messageCount: number;
	lastMessageSnippet: string | null;
	color: "none" | "red" | "green" | "yellow" | "blue" | "orange" | "purple";
	temporary: boolean;
	tokenCount: number;
};

function defaultSettings(): ChatSettings {
	return {
		provider: "openrouter",
		model: "anthropic/claude-3.7-sonnet",
		temperature: 0.8,
		topP: 1,
		systemPrompt: `\
- The current date is {{weekday}}, {{date}}.
- Use British English.
- Use Oxford English spelling.`,
		color: "none",
	};
}

export class Chat {
	id: string;
	name: string;
	history: MessageId[];
	messages: Message[];
	temporary: boolean = false;
	canAutogenerateTitle: boolean = true;
	settings: ChatSettings = defaultSettings();

	constructor(name: string, messages: Message[]) {
		this.id = `chat_${Date.now()}`;
		this.name = name;
		this.messages = messages;
		this.history = messages.map((m) => m.id);
	}

	private static constructChat(props: {
		id: string;
		name: string;
		history: MessageId[];
		messages: Message[];
		temporary: boolean;
		canAutogenerateTitle: boolean;
		settings: ChatSettings;
	}): Chat {
		const chat = new Chat(props.name, props.messages);
		chat.id = props.id;
		chat.name = props.name;
		chat.history = props.history;
		chat.messages = props.messages;
		chat.temporary = props.temporary;
		chat.settings = props.settings;
		chat.canAutogenerateTitle = props.canAutogenerateTitle;
		return chat;
	}

	public head(): ChatHead {
		return {
			id: this.id,
			name: this.name,
			messageCount: this.messages.length,
			lastMessageSnippet: this.messages[this.messages.length - 1]?.text.slice(0, 150) ?? null,
			color: this.settings.color,
			temporary: this.temporary,
			// Approximate token count based on average token length of 3.51 characters
			tokenCount: Math.floor(this.messages.reduce((acc, v) => acc + v.text.length, 0) / 3.51),
		};
	}

	public slice(until: MessageId) {
		// TODO: uncomment when swipes work
		// const historyIndex = this.history.indexOf(until);
		// const messagesIndex = this.messages.findIndex((v) => v.id === until);
		// console.log({historyIndex, messagesIndex});
		// if (historyIndex === -1 || messagesIndex === -1) {
		// 	throw new Error("`until` is not in this chat");
		// }
		// return Chat.constructChat(
		// 	this.id,
		// 	this.name,
		// 	structuredClone(this.history.slice(0, historyIndex)),
		// 	structuredClone(this.messages.slice(0, messagesIndex)),
		// 	this.settings
		// );

		const messagesIndex = this.messages.findIndex((v) => v.id === until);
		if (messagesIndex === -1) {
			throw new Error("`until` is not in this chat");
		}
		return Chat.constructChat({
			id: this.id,
			name: this.name,
			history: structuredClone(this.history),
			messages: structuredClone(this.messages.slice(0, messagesIndex)),
			temporary: this.temporary,
			settings: this.settings,
			canAutogenerateTitle: this.canAutogenerateTitle,
		});
	}

	static fromJSON(json: any): Chat {
		// Check properties
		if (
			json.id === undefined ||
			json.name === undefined ||
			json.history === undefined ||
			json.messages === undefined ||
			json.settings === undefined ||
			json.temporary === undefined ||
			json.canAutogenerateTitle === undefined
		) {
			throw new Error("Invalid JSON object");
		}
		if (
			typeof json.id !== "string" ||
			typeof json.name !== "string" ||
			!Array.isArray(json.history) ||
			!Array.isArray(json.messages) ||
			typeof json.settings !== "object"
		) {
			throw new Error("Invalid JSON object");
		}
		if (!json.id.startsWith("chat_")) {
			throw new Error("Invalid chat name");
		}

		return Chat.constructChat({
			id: json.id,
			name: json.name,
			history: json.history,
			messages: json.messages.map((m: any) => Message.fromJSON(m)),
			temporary: json.temporary,
			settings: json.settings,
			canAutogenerateTitle: json.canAutogenerateTitle
		});
	}

	toOpenAiMessages(options: {system?: string}): openrouter.OpenRouterMessage[] {
		const messages: openrouter.OpenRouterMessage[] = this.messages.map((v) => ({
			role: v.role,
			content: v.text,
		}));

		if (options.system) {
			messages.unshift({
				role: "system",
				content: options.system,
			});
		}

		for (const v of messages) {
			if (typeof v.content === "object") {
				for (const vv of v.content) {
					vv.text = macros.parseMacros(vv.text);
				}
			} else {
				v.content = macros.parseMacros(v.content);
			}
		}

		return messages;
	}

	toOpenRouterConfig(): openrouter.OpenRouterConfig {
		const messages = this.toOpenAiMessages({system: this.settings.systemPrompt});

		return {
			model: this.settings.model,
			temperature: this.settings.temperature,
			top_p: this.settings.topP,
			messages,
		};
	}

	async autogenerateTitle(): Promise<string | null> {
		const token = Bun.env.AKASH_TOKEN;
		if(!token) {
			return null;
		}

		const prompt = `Summarise the following conversation in a short title (between two and four words). Respond only with the title. Do not use formatting.`;
		const messages = [
			{role: "system", content: prompt},
			{role: "user", content: this.messages.map((v) => `# ${v.role}\n${v.text}`).join("\n\n")},
		];

		const response = await fetch("https://chatapi.akash.network/api/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				stream: false,
				model: "Meta-Llama-4-Maverick-17B-128E-Instruct-FP8",
				temperature: 0.25,
				top_p: 0.9,
				messages,
			}),
		});

		if (!response.ok) {
			console.error("Failed to generate title", await response.text(), {
				status: response.status,
				statusText: response.statusText,
			});
			throw new Error("Failed to generate title", {cause: response.statusText});
		}

		const json = await response.json();
		if (json.error) {
			throw new Error(json.error);
		}

		return json.choices[0]?.message?.content ?? null;
	}
}
