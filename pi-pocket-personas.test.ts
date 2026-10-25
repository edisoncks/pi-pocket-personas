// A test for the personas module. It runs Pi Pocket on a temporary data folder, with a scripted model, and never
// touches the owner's data. Pi Pocket does not load a `.test.ts` file as a module.
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    type App,
} from "../pi-pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { cpSync, copyFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../pi-pocket/src/server/http.ts";
import { defineDoc } from "@earendil-works/pi-durable";

const dataDir = join(root, "personas-data");
const dropIns = join(dataDir, "extensions");
const moduleFile = "personas.ts";

// The module's documents, for the tests that write them directly. Same kind, scope, and version.
const Catalog = defineDoc({
    kind: "x.personas.catalog",
    version: 2,
    scope: "session",
    checkpointWhen: () => false,
    initial: () => ({
        personas: [] as { id: string; name: string; content: string; updatedAt: number }[],
        defaultPersonaId: null as string | null,
    }),
});
const CatalogV1 = defineDoc({
    kind: "x.personas.catalog",
    version: 1,
    scope: "session",
    checkpointWhen: () => false,
    initial: () => ({
        personas: [] as { id: string; name: string; content: string; updatedAt: number }[],
    }),
});
const Active = defineDoc({
    kind: "x.personas.active",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    checkpointWhen: () => false,
    initial: () => ({ personaId: null as string | null }),
});

let app: App;
let server: Server;
let base = "";

/** The system sections in effect after replaying every `pi.system` message, as Pi Durable does. */
function sectionsOf(
    messages: readonly { role: string; sections?: Record<string, string | null> }[],
) {
    const shown: Record<string, string> = {};

    for (const message of messages) {
        if (message.role !== "system" || message.sections === undefined) {
            continue;
        }

        for (const [key, value] of Object.entries(message.sections)) {
            if (value === null) {
                delete shown[key];
            } else {
                shown[key] = value;
            }
        }
    }

    return shown;
}

async function sectionsFor(target: App, id: Parameters<App["conversation"]>[0]) {
    const view = await (await target.conversation(id))!.context(context);

    return sectionsOf(view.messages as never[]);
}

async function sectionsNow(id: Parameters<App["conversation"]>[0]) {
    return sectionsFor(app, id);
}

async function call(path: string, options: { method?: string; body?: unknown } = {}) {
    const response = await fetch(`${base}${path}`, {
        method: options.method ?? "GET",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let data: unknown = text;

    try {
        data = JSON.parse(text);
    } catch {
        // Not JSON.
    }

    return { status: response.status, data: data as never };
}

before(async () => {
    mkdirSync(dropIns, { recursive: true });
    copyFileSync(join(import.meta.dirname, "personas.ts"), join(dropIns, moduleFile));
    cpSync(join(import.meta.dirname, "personas"), join(dropIns, "personas"), {
        recursive: true,
    });

    app = await openApp(scriptedModel(), dataDir);
    await app.setExtensionEnabled(owner(app), moduleFile, true);

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("a persona is saved, chosen for one session, and injected into its prompt", async () => {
    const id = await newSession(app);
    const created = await call("/api/x/personas/personas", {
        method: "POST",
        body: { name: "Terse reviewer", content: "PERSONA-SENTINEL Answer in one sentence." },
    });

    assert.equal(created.status, 200);
    const persona = (created.data as { persona: { id: string; name: string } }).persona;

    assert.equal(persona.name, "Terse reviewer");

    const chosen = await call(`/api/x/personas/active/${String(id)}`, {
        method: "PUT",
        body: { personaId: persona.id },
    });

    assert.deepEqual(chosen.data, { activeId: persona.id });

    const state = await call(`/api/x/personas/state/${String(id)}`);

    assert.deepEqual(state.data, {
        personas: [{ id: persona.id, name: "Terse reviewer" }],
        activeId: persona.id,
        defaultPersonaId: null,
        inherited: false,
    });

    await say(app, id, "Hello");

    const sections = await sectionsNow(id);

    assert.match(sections.persona ?? "", /PERSONA-SENTINEL/);

    // Another session has no persona.
    const other = await newSession(app);
    const otherState = await call(`/api/x/personas/state/${String(other)}`);

    const otherData = otherState.data as {
        activeId: string | null;
        defaultPersonaId: string | null;
        inherited: boolean;
    };

    assert.equal(otherData.activeId, null);
    assert.equal(otherData.defaultPersonaId, null);
    assert.equal(otherData.inherited, true);

    await say(app, other, "Hello");

    assert.equal((await sectionsNow(other)).persona, undefined);
});

test("a default applies to later sessions, and a change pins what sessions use now", async () => {
    const catalog = await call("/api/x/personas/catalog");
    const persona = (catalog.data as { personas: { id: string; name: string }[] }).personas.find(
        (each) => each.name === "Terse reviewer",
    )!;
    const old = await newSession(app);
    const set = await call("/api/x/personas/default", {
        method: "POST",
        body: { personaId: persona.id },
    });

    assert.equal(set.status, 200);
    assert.equal((set.data as { defaultPersonaId: string }).defaultPersonaId, persona.id);

    // A session from before the default keeps what it had: none.
    await say(app, old, "Hello");
    assert.equal((await sectionsNow(old)).persona, undefined);

    // A session from after it starts with the default.
    const fresh = await newSession(app);
    await say(app, fresh, "Hello");
    assert.match((await sectionsNow(fresh)).persona ?? "", /PERSONA-SENTINEL/);

    // A session can still choose none while the default names a persona.
    const neither = await newSession(app);
    await call(`/api/x/personas/active/${String(neither)}`, {
        method: "PUT",
        body: { personaId: null },
    });
    await say(app, neither, "Hello");
    assert.equal((await sectionsNow(neither)).persona, undefined);

    // Changing the default pins sessions without a choice to what they use now; later sessions get the new one.
    await call("/api/x/personas/default", {
        method: "POST",
        body: { personaId: null },
    });
    const after = await newSession(app);
    await say(app, after, "Hello");
    assert.equal((await sectionsNow(after)).persona, undefined);
    await say(app, fresh, "Again");
    assert.match((await sectionsNow(fresh)).persona ?? "", /PERSONA-SENTINEL/);
});

test("a persona id must be addressable, and a persona can be updated and deleted", async () => {
    // An id that the app resolves as a path part, or that starts with punctuation, cannot be used.
    for (const id of ["..", ".", "_hidden", "-hidden", ":hidden", "x".repeat(65)]) {
        const refused = await call("/api/x/personas/personas", {
            method: "POST",
            body: { id, name: "Bad id", content: "x" },
        });

        assert.equal(refused.status, 400, `id ${JSON.stringify(id)}`);
    }

    const id = "Reviewer_1.2-beta";
    const created = await call("/api/x/personas/personas", {
        method: "POST",
        body: { id, name: "Reviewer", content: "One." },
    });

    assert.equal(created.status, 200);
    assert.equal((created.data as { persona: { id: string } }).persona.id, id);

    const updated = await call("/api/x/personas/personas", {
        method: "POST",
        body: { id, name: "Reviewer 2", content: "Two." },
    });

    assert.equal(updated.status, 200);
    assert.equal((updated.data as { persona: { name: string } }).persona.name, "Reviewer 2");

    const deleted = await call(`/api/x/personas/personas/${id}`, { method: "DELETE" });

    assert.equal(deleted.status, 200);
});

test("the command selects and clears, and the choice survives a restart", async () => {
    const id = await newSession(app);
    const catalog = await call("/api/x/personas/catalog");
    const persona = (catalog.data as { personas: { id: string; name: string }[] }).personas[0]!;
    const commandId = app.webs.commands().find((each) => each.name === "persona-use")?.id;

    assert.ok(commandId);

    const run = (args: string) =>
        app.extensionCommands.run(id, owner(app), {
            commandId: commandId!,
            args,
            requestId: crypto.randomUUID(),
        });

    assert.equal((await run("Terse reviewer")).type, "toast");
    await say(app, id, "Hello");
    assert.match((await sectionsNow(id)).persona ?? "", /PERSONA-SENTINEL/);

    assert.equal((await run("off")).type, "toast");
    await say(app, id, "Hello again");
    assert.equal((await sectionsNow(id)).persona, undefined);

    await run("Terse reviewer");
    await app.close();
    app = await openApp(scriptedModel(), dataDir);
    await say(app, id, "After the restart");
    assert.match((await sectionsNow(id)).persona ?? "", /PERSONA-SENTINEL/);

    // Turning the module off removes the section and keeps the documents; turning it on brings both back.
    await app.setExtensionEnabled(owner(app), moduleFile, false);
    await say(app, id, "With the module off");
    assert.equal((await sectionsNow(id)).persona, undefined);

    await app.setExtensionEnabled(owner(app), moduleFile, true);
    await say(app, id, "With the module on again");
    assert.match((await sectionsNow(id)).persona ?? "", /PERSONA-SENTINEL/);
});

test("placeholders are filled from the session, and unknown ones stay visible", async () => {
    const id = await newSession(app);
    const content = [
        "model={{model}}",
        "provider={{provider}}",
        "model_id={{model_id}}",
        "cwd={{cwd}}",
        "project={{project}}",
        "thinking={{thinking}}",
        "date={{date}}",
        "platform={{platform}}",
        "session={{session}}",
        "persona={{persona}}",
        "unknown={{nope}}",
        "escaped=\\{{model}}",
    ].join("\n");
    const persona = { id: crypto.randomUUID(), name: "Vars", content, updatedAt: Date.now() };

    await app.harness.commit(async (tx) => {
        (await tx.doc(Catalog)).personas.push(persona);
    }, context);
    await app.harness.commit(async (tx) => {
        (await tx.doc(Active, id)).personaId = persona.id;
    }, context);

    await say(app, id, "Hello");

    const section = (await sectionsNow(id)).persona ?? "";

    assert.match(section, /^model=.+$/m);
    assert.doesNotMatch(section, /^model=\{\{model\}\}$/m);
    assert.match(section, /^provider=faux$/m);
    assert.match(section, /^model_id=faux-1$/m);
    assert.match(section, /^cwd=.*\/work$/m);
    assert.match(section, /^project=work$/m);
    assert.match(section, /^thinking=off$/m);
    assert.match(section, new RegExp(`^date=${new Date().toISOString().slice(0, 10)}$`, "m"));
    assert.match(section, new RegExp(`^platform=${process.platform}$`, "m"));
    assert.match(section, new RegExp(`^session=${String(id)}$`, "m"));
    assert.match(section, /^persona=Vars$/m);
    // Unknown names and escaped braces are left alone.
    assert.match(section, /^unknown=\{\{nope\}\}$/m);
    assert.match(section, /^escaped=\{\{model\}\}$/m);
});

test("a version 1 catalog migrates, and its sessions keep their persona", async () => {
    const migrationDir = join(root, "personas-migration");
    const migrationDrop = join(migrationDir, "extensions");

    mkdirSync(migrationDrop, { recursive: true });
    copyFileSync(join(import.meta.dirname, "personas.ts"), join(migrationDrop, "personas.ts"));
    cpSync(join(import.meta.dirname, "personas"), join(migrationDrop, "personas"), {
        recursive: true,
    });

    const migrationApp = await openApp(scriptedModel(), migrationDir);

    try {
        await migrationApp.setExtensionEnabled(owner(migrationApp), "personas.ts", true);
        const id = await newSession(migrationApp);
        const persona = {
            id: crypto.randomUUID(),
            name: "Legacy",
            content: "PERSONA-LEGACY",
            updatedAt: Date.now(),
        };

        // A document as the first version wrote it: no defaultPersonaId.
        await migrationApp.harness.commit(async (tx) => {
            (await tx.doc(CatalogV1)).personas.push(persona);
        }, context);
        await migrationApp.harness.commit(async (tx) => {
            (await tx.doc(Active, id)).personaId = persona.id;
        }, context);

        await say(migrationApp, id, "Hello");
        assert.match((await sectionsFor(migrationApp, id)).persona ?? "", /PERSONA-LEGACY/);

        // The migrated default is none: a new session without a choice has no persona.
        const other = await newSession(migrationApp);

        await say(migrationApp, other, "Hello");
        assert.equal((await sectionsFor(migrationApp, other)).persona, undefined);
    } finally {
        await migrationApp.close();
    }
});
