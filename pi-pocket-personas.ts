/**
 * Pi Pocket Personas: saved system-prompt fragments that the owner chooses for a session, with a page to edit them and
 * a picker in the message box. The chosen persona is appended to Pi's system prompt for that session only.
 *
 * Data lives in two Pi Durable documents in pocket.sqlite: the catalog (`x.personas.catalog`, app-wide) and the choice
 * for each session (`x.personas.active`, by conversation). The kinds keep their first names so that personas saved by
 * the earlier `personas.ts` module are still there. The browser module is `personas-ui/index.js`.
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { defineDoc, defineExtension, section } from "@earendil-works/pi-durable";
import type { ConversationId, PromptInput } from "@earendil-works/pi-durable";
import type { Host, Web } from "./_pocket.d.ts";

/** The version of Pi Pocket's extension API this module is written for. */
export const pocketApi = 1;

/** One saved persona. `id` never changes; `updatedAt` is for the list's order. */
type Persona = {
    id: string;
    name: string;
    content: string;
    updatedAt: number;
};

/** The saved personas and the default for new sessions, once for the whole data folder. */
type CatalogDoc = {
    personas: Persona[];
    defaultPersonaId: string | null;
};

const Catalog = defineDoc<CatalogDoc>({
    kind: "x.personas.catalog",
    version: 2,
    scope: "session",
    initial: () => ({ personas: [], defaultPersonaId: null }),
    // Version 1 had no default: its sessions start with none, as they did before.
    migrate: (value) => ({
        personas: Array.isArray(value.personas) ? (value.personas as Persona[]) : [],
        defaultPersonaId:
            typeof value.defaultPersonaId === "string" ? value.defaultPersonaId : null,
    }),
    // A full base every so often keeps replay bounded, however often the owner edits.
    checkpointWhen: (_value, _ops, info) => info.deltasSinceBase > 50,
});

/** The persona chosen for one session, or none. `fork: "current"` keeps it in a fork. */
const Active = defineDoc<{ personaId: string | null }>({
    kind: "x.personas.active",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ personaId: null }),
    checkpointWhen: () => false,
});

/** A name from the browser: text, not empty, bounded. */
function nameOf(value: unknown, web: Web): string {
    if (typeof value !== "string") {
        throw web.error(400, "The name must be text.");
    }

    const name = value.trim();

    if (name === "") {
        throw web.error(400, "The name must not be empty.");
    }

    if (name.length > 80) {
        throw web.error(400, "The name is too long (80 characters at most).");
    }

    return name;
}

/** Persona text from the browser: text, not empty, bounded. Whitespace is kept as typed. */
function contentOf(value: unknown, web: Web): string {
    if (typeof value !== "string") {
        throw web.error(400, "The persona text must be text.");
    }

    if (value.trim() === "") {
        throw web.error(400, "The persona text must not be empty.");
    }

    if (value.length > 20_000) {
        throw web.error(400, "The persona text is too long (20,000 characters at most).");
    }

    return value;
}

/** A session id from a path, or a 404. The caller checks that the person sees it. */
function sessionOf(value: string, web: Web): number {
    const id = Number(value);

    if (!Number.isSafeInteger(id) || id < 1) {
        throw web.error(404, "No such session");
    }

    return id;
}

/** Pi Durable brands its ids; a session number from a route is one after the visibility check. */
function conversationOf(id: number): ConversationId {
    return id as unknown as ConversationId;
}

/** The values a persona may use: filled at each request, so a change shows from the next request. */
function varsFor(input: PromptInput, host: Host): Record<string, string> {
    const cwd = input.env?.cwd ?? input.agent.cwd ?? "";
    const model = input.agent.model;
    const info =
        model === undefined ? undefined : host.modelInfo(`${model.provider}/${model.modelId}`);

    return {
        model: info?.name ?? (model === undefined ? "none" : `${model.provider}/${model.modelId}`),
        model_id: model?.modelId ?? "none",
        provider: model?.provider ?? "none",
        cwd,
        project: cwd === "" ? "" : basename(cwd),
        thinking: input.agent.thinkingLevel,
        date: new Date().toISOString().slice(0, 10),
        platform: process.platform,
        session: String(input.conversationId),
    };
}

/**
 * Fill `{{name}}` from `vars`. A name that is not known stays as typed, so a typo is visible. `\{{` writes a literal
 * `{{`, for persona text that shows a template of its own.
 */
function expand(text: string, vars: Record<string, string>): string {
    let out = "";
    let at = 0;

    while (at < text.length) {
        const open = text.indexOf("{{", at);

        if (open === -1) {
            out += text.slice(at);
            break;
        }

        // A backslash before the braces keeps them as text, the way a template engine escapes them.
        if (open > 0 && text[open - 1] === "\\") {
            out += `${text.slice(at, open - 1)}{{`;
            at = open + 2;
            continue;
        }

        const close = text.indexOf("}}", open + 2);

        if (close === -1) {
            out += text.slice(at);
            break;
        }

        const name = text
            .slice(open + 2, close)
            .trim()
            .toLowerCase();
        const value = Object.hasOwn(vars, name) ? vars[name] : undefined;

        if (value === undefined) {
            out += text.slice(at, close + 2);
        } else {
            out += text.slice(at, open) + value;
        }

        at = close + 2;
    }

    return out;
}

export default function createPersonas(host: Host, web: Web) {
    const personaSection = section("persona", async (input, context) => {
        const catalog = await input.read.snapshot(Catalog, context);
        const active = await input.read.snapshot(Active, input.conversationId, context);
        // A session that never chose follows the default; one that chose, even "none", keeps its choice.
        const personaId =
            active === undefined ? (catalog?.defaultPersonaId ?? null) : active.personaId;

        if (personaId === null) {
            return undefined;
        }

        const persona = catalog?.personas.find((each) => each.id === personaId);

        if (persona === undefined) {
            return undefined;
        }

        const vars = varsFor(input, host);

        vars.persona = persona.name;

        return `Persona: ${persona.name}\n\n${expand(persona.content, vars)}`;
    });

    // The picker and the status line need names only; a session must be one that this person sees.
    web.route("GET", "state/:session", async ({ params, snapshot, context, sessions }) => {
        const session = sessionOf(params.session, web);

        if (!sessions().some((each) => each.id === session)) {
            throw web.error(404, "No such session");
        }

        const catalog = await snapshot(Catalog, context);
        const active = await snapshot(Active, conversationOf(session), context);
        const saved = [...(catalog?.personas ?? [])].sort((a, b) => a.name.localeCompare(b.name));
        const defaultPersonaId = catalog?.defaultPersonaId ?? null;
        const chosen = active === undefined ? defaultPersonaId : active.personaId;
        const activeId = saved.some((each) => each.id === chosen) ? chosen : null;

        return {
            personas: saved.map(({ id, name }) => ({ id, name })),
            activeId,
            defaultPersonaId,
            inherited: active === undefined,
        };
    });

    // The manager edits full personas: owner alone, the default for every route.
    web.route("GET", "catalog", async ({ snapshot, context }) => {
        const catalog = await snapshot(Catalog, context);

        return {
            personas: [...(catalog?.personas ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
            defaultPersonaId: catalog?.defaultPersonaId ?? null,
        };
    });

    // The default for sessions made from now on. Sessions without a choice are pinned to what they use now, so the
    // new default does not change them.
    web.route("POST", "default", async ({ body, snapshot, commit, context, sessions }) => {
        const personaId = body.personaId;

        if (personaId !== null && typeof personaId !== "string") {
            throw web.error(400, "The default must be a persona id, or null for none.");
        }

        const catalog = await snapshot(Catalog, context);

        if (personaId !== null && !catalog?.personas.some((each) => each.id === personaId)) {
            throw web.error(400, "No such persona");
        }

        const previous = catalog?.defaultPersonaId ?? null;
        const keep =
            previous !== null && catalog?.personas.some((each) => each.id === previous)
                ? previous
                : null;
        const checks = await Promise.all(
            sessions().map(async (each) => ({
                id: each.id,
                active: await snapshot(Active, conversationOf(each.id), context),
            })),
        );
        const pinned = checks.filter((each) => each.active === undefined).map((each) => each.id);

        await commit(async (tx) => {
            const doc = await tx.doc(Catalog);

            doc.defaultPersonaId = personaId;

            for (const id of pinned) {
                const active = await tx.doc(Active, conversationOf(id));

                active.personaId = keep;
            }
        });

        web.send("catalog", {});

        return { defaultPersonaId: personaId, pinned: pinned.length };
    });

    web.route("POST", "personas", async ({ body, commit }) => {
        const id = typeof body.id === "string" && body.id !== "" ? body.id : undefined;

        if (id !== undefined && !/^[A-Za-z0-9._:-]{1,64}$/.test(id)) {
            throw web.error(400, "That persona id is not valid.");
        }

        const name = nameOf(body.name, web);
        const content = contentOf(body.content, web);

        const persona = await commit(async (tx) => {
            const doc = await tx.doc(Catalog);
            const index = id === undefined ? -1 : doc.personas.findIndex((each) => each.id === id);
            const next: Persona = {
                id: id ?? randomUUID(),
                name,
                content,
                updatedAt: Date.now(),
            };

            if (index === -1) {
                doc.personas.push(next);
            } else {
                doc.personas[index] = next;
            }

            return next;
        });

        web.send("catalog", {});

        return { persona };
    });

    web.route("DELETE", "personas/:id", async ({ params, commit }) => {
        await commit(async (tx) => {
            const doc = await tx.doc(Catalog);
            const index = doc.personas.findIndex((each) => each.id === params.id);

            // Throwing rolls the commit back, so a bad id changes nothing.
            if (index === -1) {
                throw web.error(404, "No such persona");
            }

            doc.personas.splice(index, 1);

            // A default that pointed at it is cleared; sessions that used it fall back to none.
            if (doc.defaultPersonaId === params.id) {
                doc.defaultPersonaId = null;
            }
        });

        web.send("catalog", {});

        return { ok: true };
    });

    web.route(
        "PUT",
        "active/:session",
        async ({ params, body, snapshot, commit, context, sessions }) => {
            const session = sessionOf(params.session, web);

            if (!sessions().some((each) => each.id === session)) {
                throw web.error(404, "No such session");
            }

            const personaId = body.personaId;

            if (personaId !== null && typeof personaId !== "string") {
                throw web.error(400, "The persona must be an id, or null for none.");
            }

            if (personaId !== null) {
                const catalog = await snapshot(Catalog, context);

                if (!catalog?.personas.some((each) => each.id === personaId)) {
                    throw web.error(400, "No such persona");
                }
            }

            await commit(async (tx) => {
                const doc = await tx.doc(Active, conversationOf(session));

                doc.personaId = personaId;
            });

            web.send("changed", { session, personaId });

            return { activeId: personaId };
        },
    );

    // A keyboard path: `/persona-use Terse reviewer`, `/persona-use off`, or `/persona-use` to list.
    web.command("persona-use", {
        description: "Choose the persona for this session",
        args: "[name|off]",
        scope: "global",
        handler: async (args, ctx) => {
            const catalog = await ctx.snapshot(Catalog, ctx.context);
            const personas = catalog?.personas ?? [];
            const wanted = args.trim();

            if (wanted === "" || wanted.toLowerCase() === "list") {
                return {
                    type: "toast",
                    level: "info",
                    message:
                        personas.length === 0
                            ? "No personas saved yet."
                            : `Personas: ${personas.map((each) => each.name).join(", ")}`,
                };
            }

            const lower = wanted.toLowerCase();

            if (lower === "off" || lower === "none" || lower === "clear") {
                await ctx.commit(async (tx) => {
                    const doc = await tx.doc(Active, ctx.conversationId);

                    doc.personaId = null;
                });

                web.send("changed", { session: ctx.conversationId, personaId: null });

                return { type: "toast", level: "info", message: "Persona cleared." };
            }

            const persona = personas.find(
                (each) => each.id === wanted || each.name.toLowerCase() === lower,
            );

            if (persona === undefined) {
                return {
                    type: "toast",
                    level: "error",
                    message: `No persona named “${wanted}”.`,
                };
            }

            await ctx.commit(async (tx) => {
                const doc = await tx.doc(Active, ctx.conversationId);

                doc.personaId = persona.id;
            });

            web.send("changed", { session: ctx.conversationId, personaId: persona.id });

            return { type: "toast", level: "info", message: `Persona: ${persona.name}.` };
        },
    });

    // The page, picker, and buttons live in the folder beside this file.
    web.client("personas-ui");

    return defineExtension({ name: "pi-pocket-personas", sections: [personaSection] });
}
