// The personas browser module in a real Chromium: the manager page saves a persona, the message-box picker attaches it,
// and the status line says which one the session uses. It runs on a temporary data folder.
import {
    cleanUp,
    context,
    newSession,
    lastText,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    type App,
} from "../pi-pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { cpSync, copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../pi-pocket/src/server/browser.ts";
import { findBrowser } from "../pi-pocket/src/server/browser/discovery.ts";
import type { BrowserPage } from "../pi-pocket/src/server/browser/page.ts";
import { createHandler } from "../pi-pocket/src/server/http.ts";

const model = scriptedModel((context) => {
    const { text } = lastText(context as never);

    if (text.includes("SLOW")) {
        return new Promise((resolve) => {
            const timer = setTimeout(
                () => resolve(fauxAssistantMessage([fauxText("done")])),
                30_000,
            );

            timer.unref();
        });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
});

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };
const dataDir = join(root, "personas-ui-data");
const dropIns = join(dataDir, "extensions");

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: Parameters<App["conversation"]>[0];

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

async function sectionsNow(id: Parameters<App["conversation"]>[0]) {
    const view = await (await app.conversation(id))!.context(context);

    return sectionsOf(view.messages as never[]);
}

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;

const has = (selector: string) =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`,
    );

const text = (selector: string) =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? "")`,
    );

async function settled() {
    await until(async () => {
        const running = await inPage<boolean>(
            `return JSON.stringify(document.getAnimations().some((each) => each.playState === "running" && each.effect?.getComputedTiming().endTime !== Infinity))`,
        );

        return !running;
    }, "animations to finish");

    await new Promise((resolve) => setTimeout(resolve, 450));
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(dropIns, { recursive: true });
    copyFileSync(join(import.meta.dirname, "personas.ts"), join(dropIns, "personas.ts"));
    cpSync(join(import.meta.dirname, "personas"), join(dropIns, "personas"), {
        recursive: true,
    });

    app = await openApp(model, dataDir);
    await app.setExtensionEnabled(owner(app), "personas.ts", true);
    session = await newSession(app);

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "personas-ui-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(DESKTOP);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "the manager saves a persona, the picker attaches it, and the status line shows it",
    real,
    async () => {
        const status = () => text('[data-part="status-item"] .long');

        await page.navigate(`${base}/s/${String(session)}`);
        await until(() => has('.sidebar .rail-ext[title="Personas"]'), "the Personas rail button");
        await settled();

        // Make one in the manager page.
        await page.click({ selector: '.sidebar .rail-ext[title="Personas"]' });
        await until(() => has(".x-personas"), "the personas page");
        await settled();
        await page.click({ label: "New persona" });

        const hint = await inPage<string>(
            `return JSON.stringify(document.querySelector(".x-personas-vars code")?.textContent ?? "")`,
        );

        assert.equal(hint, "\\{{");
        await page.type({ selector: ".x-personas-input" }, "Terse reviewer");
        await page.type(
            { selector: ".x-personas-text" },
            "PERSONA-UI project={{project}} unknown={{nope}}",
        );
        await page.waitFor({ text: "Unknown:" });
        assert.match(await text(".x-personas-warn"), /\{\{nope\}\}/);
        await page.click({ label: "Save" });
        await page.waitFor({ text: "Saved" });

        // Save it as the default for new sessions too.
        await until(() => has(".x-personas-select"), "the default selector");
        await page.evaluate(`(() => {
            const select = document.querySelector(".x-personas-select");
            const option = [...select.options].find((each) => each.textContent.trim() === "Terse reviewer");
            select.value = option.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return JSON.stringify(null);
        })()`);
        await page.waitFor({ text: "Default saved" });

        await page.click({ selector: '.ext-page [aria-label="Close"]' });
        await until(async () => !(await has(".ext-page")), "the page to close");

        // Choose it for the session from the message box.
        await settled();
        await page.click({ selector: '[aria-label="Persona"]' });
        await until(() => has(".x-personas-picker"), "the persona picker");
        await settled();
        await page.click({ label: "Terse reviewer" });
        await until(async () => (await status()) === "persona: Terse reviewer", "the status line");

        const line = JSON.parse(
            await page.evaluate(
                `return JSON.stringify(document.querySelector(".status-line").innerText.replace(/\\s+/g, " ").trim())`,
            ),
        ) as string;

        assert.ok(
            line.indexOf("$0.00") < line.indexOf("persona: Terse reviewer"),
            `the persona comes after the costs: ${line}`,
        );

        await say(app, session, "Hello");
        const injected = (await sectionsNow(session)).persona ?? "";

        assert.match(injected, /PERSONA-UI/);
        assert.match(injected, /project=work/);
        assert.match(injected, /unknown=\{\{nope\}\}/);

        // A session made after the default starts with it.
        const fresh = await newSession(app);

        await page.navigate(`${base}/s/${String(fresh)}`);
        await until(
            async () => (await status()) === "persona: Terse reviewer",
            "the default persona in a new session",
        );
        await say(app, fresh, "Hello");
        assert.match((await sectionsNow(fresh)).persona ?? "", /PERSONA-UI/);

        // A reload keeps the choice, and the picker clears it.
        await page.navigate(`${base}/s/${String(session)}`);
        await page.navigate(`${base}/s/${String(session)}`);
        await until(
            async () => (await status()) === "persona: Terse reviewer",
            "the status after a reload",
        );
        await page.click({ selector: '[aria-label="Persona"]' });
        await until(() => has(".x-personas-picker"), "the picker again");
        await settled();
        await page.click({ label: "No persona" });
        await until(async () => (await status()) === "no persona", "the cleared status");

        await say(app, session, "Hello again");
        assert.equal((await sectionsNow(session)).persona, undefined);
    },
);

test("the manager and message box fit a phone", real, async () => {
    await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
    await page.navigate(`${base}/s/${String(session)}`);
    await until(() => has('[data-part="status-item"]'), "the status item");
    await until(
        async () => !(await has('[aria-label="Persona"]')),
        "no Persona button in the message box",
    );
    assert.equal(await text('[data-part="status-item"] .short'), "—");

    // While Pi works, Steer, Queue, and Interrupt join the row. It must still fit.
    await app.commands.submit(session, owner(app), {
        text: "SLOW",
        requestId: crypto.randomUUID(),
    });
    await until(() => has(".composer.busy .mode-switch"), "the busy composer");
    await settled();

    const busy = JSON.parse(
        await page.evaluate(`return JSON.stringify((() => {
            const row = document.querySelector('[data-part="composer-tools"]');
            const stop = document.querySelector(".stop-button");
            return {
                scroll: row.scrollWidth,
                client: row.clientWidth,
                stopRight: stop ? stop.getBoundingClientRect().right : null,
                inner: window.innerWidth,
            };
        })())`),
    ) as { scroll: number; client: number; stopRight: number | null; inner: number };

    assert.ok(busy.scroll <= busy.client + 1, `the busy row overflows: ${JSON.stringify(busy)}`);
    assert.ok(
        busy.stopRight !== null && busy.stopRight <= busy.inner + 1,
        `Stop is off screen: ${JSON.stringify(busy)}`,
    );

    await app.commands.abort(session, owner(app));

    // The launcher opens the manager page.
    await page.press("Control+k");
    await until(() => has(".launcher-input input"), "the launcher");
    await page.type({ selector: ".launcher-input input" }, "Personas");
    await until(
        () => has('[data-part="launcher-row"][title^="Personas"]'),
        "the Personas launcher action",
    );
    await page.click({ selector: '[data-part="launcher-row"][title^="Personas"]' });
    await until(() => has(".x-personas"), "the personas page");
    await settled();

    const button = JSON.parse(
        await page.evaluate(
            `return JSON.stringify(document.querySelector(".x-personas-head .button").getBoundingClientRect())`,
        ),
    ) as { width: number; height: number };

    assert.ok(button.height < 60, `the New persona button is too tall: ${button.height}`);
    assert.ok(button.width < 200, `the New persona button is too wide: ${button.width}`);

    const box = JSON.parse(
        await page.evaluate(
            `return JSON.stringify({ scroll: document.querySelector(".x-personas").scrollWidth, client: document.querySelector(".x-personas").clientWidth })`,
        ),
    ) as { scroll: number; client: number };

    assert.ok(box.scroll <= box.client + 1, `the page overflows: ${JSON.stringify(box)}`);

    await page.setViewport(DESKTOP);
});

test("the manager reports a failed catalog and locks the editor while saving", real, async () => {
    await page.navigate(`${base}/s/${String(session)}`);
    await until(() => has('.sidebar .rail-ext[title="Personas"]'), "the Personas rail button");

    // Make the catalog route fail, then open the manager.
    await page.evaluate(`(() => {
        window.__personasFetch = window.fetch;
        window.fetch = (url, options) =>
            String(url).includes("/api/x/personas/catalog")
                ? Promise.resolve(new Response(JSON.stringify({ error: "Catalog unavailable" }), {
                      status: 500,
                      headers: { "content-type": "application/json" },
                  }))
                : window.__personasFetch(url, options);
        return JSON.stringify(null);
    })()`);
    await page.click({ selector: '.sidebar .rail-ext[title="Personas"]' });
    await until(() => has(".x-personas"), "the personas page");
    await page.waitFor({ text: "Could not read the catalog." });
    await settled();

    assert.match(await text(".error-box"), /Catalog unavailable/);
    assert.match(await text(".x-personas-list"), /Could not read the catalog/);
    assert.doesNotMatch(await text(".x-personas-list"), /Reading personas/);

    // The next load succeeds: reload the tab, then open the manager again.
    await page.navigate(`${base}/s/${String(session)}`);
    await until(() => has('.sidebar .rail-ext[title="Personas"]'), "the Personas rail button");
    await page.click({ selector: '.sidebar .rail-ext[title="Personas"]' });
    await until(() => has(".x-personas"), "the personas page again");
    await settled();

    // A slow save keeps the editor locked until the answer.
    await page.click({ label: "New persona" });
    await page.type({ selector: ".x-personas-input" }, "Slow save");
    await page.type({ selector: ".x-personas-text" }, "Wait for me.");
    await page.evaluate(`(() => {
        const original = window.fetch;
        window.__personasFetch = original;
        window.fetch = (url, options) =>
            String(url).includes("/api/x/personas/personas") && options?.method === "POST"
                ? new Promise((resolve) => setTimeout(() => resolve(original(url, options)), 1500))
                : original(url, options);
        return JSON.stringify(null);
    })()`);
    await page.click({ label: "Save" });
    await until(async () => {
        const locked = await inPage<{ rows: boolean; input: boolean; text: boolean }>(
            `return JSON.stringify({
                rows: [...document.querySelectorAll(".x-personas-row")].every((each) => each.disabled),
                input: document.querySelector(".x-personas-input")?.disabled ?? false,
                text: document.querySelector(".x-personas-text")?.disabled ?? false,
            })`,
        );

        return locked.rows && locked.input && locked.text;
    }, "the editor to be disabled while saving");
    await page.waitFor({ text: "Saved" });
    await until(async () => {
        const unlocked = await inPage<boolean>(
            `return JSON.stringify(
                !document.querySelector(".x-personas-input")?.disabled &&
                !document.querySelector(".x-personas-text")?.disabled &&
                [...document.querySelectorAll(".x-personas-row")].every((each) => !each.disabled)
            )`,
        );

        return unlocked;
    }, "the editor to be enabled again");

    await page.evaluate(
        `(() => { window.fetch = window.__personasFetch; return JSON.stringify(null); })()`,
    );
});
