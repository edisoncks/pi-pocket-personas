/**
 * The personas browser module: a page to edit saved personas, a sheet to choose one for the session, a button in the
 * message box, and an item in the status line. It talks only to `pi-pocket-personas.ts` routes; the persona text never lives in
 * this folder, which the app serves to the owner's tabs.
 */

/** The version of `pocket` this module was written for. */
export const pocketApi = 1;

const BLANK = { id: null, name: "", content: "" };

/** A persona: a theatre mask, distinct from the app's people and invites icons. */
const MASK =
    "M5 5.5C6.8 4.5 9.1 4 12 4s5.2.5 7 1.5c-.2 3.3-1 6.4-2.6 8.9-1.2 1.9-2.7 3-4.4 3.6-1.7-.6-3.2-1.7-4.4-3.6C6 11.9 5.2 8.8 5 5.5ZM9 9.25h.01M15 9.25h.01M9 13c.8.8 1.8 1.2 3 1.2s2.2-.4 3-1.2";

/** What a persona may put between braces, and what it becomes at each request. */
const VARIABLES = [
    ["model", "the model's name"],
    ["provider", "the provider"],
    ["model_id", "the model's id"],
    ["cwd", "the session's folder"],
    ["project", "the folder's name"],
    ["thinking", "the thinking level"],
    ["date", "today, as YYYY-MM-DD"],
    ["platform", "the operating system"],
    ["session", "the session id"],
    ["persona", "this persona's name"],
];
const KNOWN_VARIABLES = new Set(VARIABLES.map(([name]) => name));
const VARIABLE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi;

/** Names in `{{name}}` that the module does not fill, so the editor can point at a typo. */
function unknownVariables(text) {
    const names = new Set();

    for (const match of text.matchAll(VARIABLE)) {
        const name = match[1].toLowerCase();
        const escaped = match.index > 0 && text[match.index - 1] === "\\";

        if (!escaped && !KNOWN_VARIABLES.has(name)) {
            names.add(match[1]);
        }
    }

    return [...names];
}

/** A first line for the list, short enough for a row. */
function preview(text) {
    const line = text.trim().split("\n", 1)[0] ?? "";

    return line.length > 70 ? `${line.slice(0, 69)}…` : line;
}

function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}

export default function setup(pocket) {
    const { html, useEffect, useRef, useState } = pocket;

    /* ── The status line: the persona of the session the tab shows ───────────────────────────── */

    const statusItem =
        typeof pocket.status === "function"
            ? pocket.status({
                  id: "persona",
                  text: "persona …",
                  short: "…",
                  title: "Persona",
                  after: "core:spend",
                  sheet: "pick",
              })
            : null;

    let statusSession = null;
    let statusSeq = 0;

    async function refreshStatus(session) {
        if (statusItem === null) {
            return;
        }

        const mine = ++statusSeq;

        if (session === null) {
            statusItem.update({
                text: "persona —",
                short: "—",
                title: "Persona",
                tone: "muted",
            });
            return;
        }

        try {
            const state = await pocket.api(`state/${session}`);

            if (mine !== statusSeq) {
                return;
            }

            const persona = state.personas.find((each) => each.id === state.activeId);

            statusItem.update(
                persona
                    ? {
                          text: `persona: ${persona.name}`,
                          short: "P",
                          title: `Persona: ${persona.name} — tap to change`,
                          tone: undefined,
                      }
                    : {
                          text: "no persona",
                          short: "—",
                          title: "No persona in this session — tap to choose one",
                          tone: "muted",
                      },
            );
        } catch (failure) {
            if (mine === statusSeq) {
                statusItem.update({
                    text: "persona ?",
                    short: "?",
                    title: `Could not read the persona: ${errorText(failure)}`,
                    tone: "warn",
                });
            }
        }
    }

    const stops = [];

    stops.push(
        pocket.on("changed", (data) => {
            if (data !== null && typeof data === "object" && data.session === statusSession) {
                void refreshStatus(statusSession);
            }
        }),
    );
    // The default changed: an inherited persona shows a new name.
    stops.push(pocket.on("catalog", () => void refreshStatus(statusSession)));

    if (typeof pocket.onConversation === "function") {
        stops.push(
            pocket.onConversation((id) => {
                statusSession = id;
                void refreshStatus(id);
            }),
        );
    } else {
        statusSession = pocket.conversationId();
        void refreshStatus(statusSession);
    }

    /* ── The picker: one persona for the session ─────────────────────────────────────────────── */

    function Picker({ close }) {
        const session = pocket.conversationId();
        const [state, setState] = useState(null);
        const [error, setError] = useState(null);
        const [busy, setBusy] = useState(false);

        const load = async (signal) => {
            if (session === null) {
                setError("Open a session first.");
                return;
            }

            try {
                const next = await pocket.api(`state/${session}`, undefined, { signal });

                setState(next);
                setError(null);
            } catch (failure) {
                if (!signal?.aborted) {
                    setError(errorText(failure));
                }
            }
        };

        useEffect(() => {
            const controller = new AbortController();
            void load(controller.signal);
            const off = pocket.on("changed", (data) => {
                if (data !== null && typeof data === "object" && data.session === session) {
                    void load();
                }
            });
            const offCatalog = pocket.on("catalog", () => void load());

            return () => {
                controller.abort();
                off();
                offCatalog();
            };
        }, []);

        async function choose(personaId) {
            if (busy || session === null) {
                return;
            }

            setBusy(true);

            try {
                await pocket.api(`active/${session}`, { personaId }, { method: "PUT" });
                close();
            } catch (failure) {
                setError(errorText(failure));
            } finally {
                setBusy(false);
            }
        }

        if (error !== null && state === null) {
            return html`<div class="error-box">${error}</div>`;
        }

        if (state === null) {
            return html`<${pocket.Loader} label="Reading personas" />`;
        }

        const inherited = state.inherited
            ? (state.personas.find((each) => each.id === state.activeId)?.name ?? null)
            : null;

        return html`<div class="x-personas-picker">
            ${
                state.inherited
                    ? html`<p class="muted small x-personas-inherited">
                          Default for new sessions: ${inherited ?? "no persona"}
                      </p>`
                    : null
            }
            <button
                type="button"
                class=${"x-personas-option" + (state.activeId === null ? " chosen" : "")}
                disabled=${busy}
                onClick=${() => choose(null)}
            >
                <span>No persona</span>
                ${state.activeId === null ? html`<${pocket.Icon} name="check" size=${16} />` : null}
            </button>
            ${state.personas.map(
                (persona) =>
                    html`<button
                        key=${persona.id}
                        type="button"
                        class=${"x-personas-option" + (state.activeId === persona.id ? " chosen" : "")}
                        disabled=${busy}
                        onClick=${() => choose(persona.id)}
                    >
                        <span>${persona.name}</span>
                        ${
                            state.activeId === persona.id
                                ? html`<${pocket.Icon} name="check" size=${16} />`
                                : null
                        }
                    </button>`,
            )}
            ${
                state.personas.length === 0
                    ? html`<p class="muted small">
                          No personas saved yet. Add one in Menu → Personas.
                      </p>`
                    : null
            }
            ${error !== null ? html`<div class="error-box">${error}</div>` : null}
        </div>`;
    }

    /* ── The manager: the catalog, with an editor ───────────────────────────────────────────── */

    function Manager() {
        const [personas, setPersonas] = useState(null);
        const [defaultId, setDefaultId] = useState(null);
        const [draft, setDraft] = useState(null);
        const [error, setError] = useState(null);
        const [note, setNote] = useState(null);
        const [busy, setBusy] = useState(false);
        const [confirmId, setConfirmId] = useState(null);
        const editor = useRef(null);

        const load = async (signal) => {
            try {
                const data = await pocket.api("catalog", undefined, { signal });

                if (signal?.aborted) {
                    return;
                }

                setPersonas(data.personas);
                setDefaultId(data.defaultPersonaId ?? null);
                setError(null);
            } catch (failure) {
                if (!signal?.aborted) {
                    setError(errorText(failure));
                }
            }
        };

        useEffect(() => {
            const controller = new AbortController();
            void load(controller.signal);
            // Another tab of this owner changed the catalog: show the same list here.
            const off = pocket.on("catalog", () => void load());

            return () => {
                controller.abort();
                off();
            };
        }, []);

        function edit(persona) {
            setDraft({ id: persona.id, name: persona.name, content: persona.content });
            setConfirmId(null);
            setError(null);
            setNote(null);

            if (window.innerWidth < 700) {
                requestAnimationFrame(() => {
                    editor.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                });
            }
        }

        function create() {
            setDraft({ ...BLANK });
            setConfirmId(null);
            setError(null);
            setNote(null);

            if (window.innerWidth < 700) {
                requestAnimationFrame(() => {
                    editor.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                });
            }
        }

        async function setDefault(event) {
            if (busy) {
                return;
            }

            const personaId = event.currentTarget.value === "" ? null : event.currentTarget.value;

            setBusy(true);
            setError(null);
            setNote(null);

            try {
                const saved = await pocket.api("default", { personaId });

                setDefaultId(saved.defaultPersonaId);
                await load();
                setNote(
                    saved.pinned === 0
                        ? "Default saved. New sessions use it."
                        : `Default saved. ${saved.pinned} session${saved.pinned === 1 ? "" : "s"} kept what they had.`,
                );
            } catch (failure) {
                setError(errorText(failure));
            } finally {
                setBusy(false);
            }
        }

        async function save() {
            if (draft === null || busy) {
                return;
            }

            const name = draft.name.trim();

            if (name === "") {
                setError("Give the persona a name.");
                return;
            }

            setBusy(true);
            setError(null);
            setNote(null);

            try {
                const saved = await pocket.api("personas", {
                    id: draft.id ?? undefined,
                    name,
                    content: draft.content,
                });

                setDraft({
                    id: saved.persona.id,
                    name: saved.persona.name,
                    content: saved.persona.content,
                });
                await load();
                setNote(
                    `Saved “${saved.persona.name}”. Sessions that use it get it from the next request.`,
                );
            } catch (failure) {
                setError(errorText(failure));
            } finally {
                setBusy(false);
            }
        }

        async function remove(id) {
            if (busy) {
                return;
            }

            setBusy(true);
            setError(null);
            setNote(null);

            try {
                await pocket.api(`personas/${encodeURIComponent(id)}`, undefined, {
                    method: "DELETE",
                });

                if (draft?.id === id) {
                    setDraft(null);
                }

                setConfirmId(null);
                await load();
                setNote("Deleted. Sessions that used it now have no persona.");
            } catch (failure) {
                setError(errorText(failure));
            } finally {
                setBusy(false);
            }
        }

        const unknown = draft === null ? [] : unknownVariables(draft.content);

        return html`<div class="x-personas">
            <div class="x-personas-head">
                <div>
                    <h2 class="x-personas-title">Personas</h2>
                    <p class="muted small">
                        Saved instructions that Pi follows in a session. They go to the model
                        provider with the rest of the system prompt; keep secrets out.
                    </p>
                </div>
                <button type="button" class="button primary" onClick=${create}>New persona</button>
            </div>
            ${error !== null ? html`<div class="error-box">${error}</div>` : null}
            ${note !== null ? html`<p class="small x-personas-note">${note}</p>` : null}
            <div class="x-personas-default">
                <label class="x-personas-default-label">
                    <span class="x-personas-default-title">Default for new sessions</span>
                    <select
                        class="x-personas-select"
                        value=${defaultId ?? ""}
                        disabled=${busy || personas === null}
                        onChange=${setDefault}
                    >
                        <option value="">No persona</option>
                        ${(personas ?? []).map(
                            (persona) =>
                                html`<option key=${persona.id} value=${persona.id}>
                                    ${persona.name}
                                </option>`,
                        )}
                    </select>
                </label>
                <p class="muted small">
                    Sessions with their own choice keep it. A new session starts with this.
                </p>
            </div>
            <div class="x-personas-grid">
                <nav class="x-personas-list" aria-label="Saved personas">
                    ${
                        personas === null
                            ? html`<${pocket.Loader} label="Reading personas" />`
                            : personas.length === 0
                              ? html`<p class="muted small">
                                    No personas yet. Make the first one.
                                </p>`
                              : personas.map(
                                    (persona) =>
                                        html`<button
                                            key=${persona.id}
                                            type="button"
                                            class=${
                                                "x-personas-row" +
                                                (draft?.id === persona.id ? " current" : "")
                                            }
                                            onClick=${() => edit(persona)}
                                        >
                                            <span class="x-personas-row-name">${persona.name}</span>
                                            <span class="x-personas-row-preview"
                                                >${preview(persona.content)}</span
                                            >
                                        </button>`,
                                )
                    }
                </nav>
                <section class="x-personas-pane" ref=${editor} id="x-personas-editor">
                    ${
                        draft === null
                            ? html`<p class="muted">Select a persona, or make a new one.</p>`
                            : html`<div class="x-personas-editor">
                                  <label class="x-personas-label">
                                      <span class="muted small">Name</span>
                                      <input
                                          class="x-personas-input"
                                          value=${draft.name}
                                          maxlength=${80}
                                          placeholder="e.g. Terse reviewer"
                                          onInput=${(event) =>
                                              setDraft({
                                                  ...draft,
                                                  name: event.currentTarget.value,
                                              })}
                                      />
                                  </label>
                                  <label class="x-personas-label">
                                      <span class="muted small">Persona text</span>
                                      <textarea
                                          class="x-personas-text"
                                          rows=${14}
                                          value=${draft.content}
                                          placeholder="How Pi should speak and behave in this session…"
                                          onInput=${(event) =>
                                              setDraft({
                                                  ...draft,
                                                  content: event.currentTarget.value,
                                              })}
                                      ></textarea>
                                  </label>
                                  <p class="muted small x-personas-vars">
                                      Variables:
                                      ${VARIABLES.map(([name]) => `{{${name}}}`).join(" · ")}
                                  </p>
                                  <p class="muted small x-personas-vars">
                                      Unknown names stay as typed; write <code>{{</code> for a
                                      literal brace.
                                  </p>
                                  ${
                                      unknown.length > 0
                                          ? html`<p class="small x-personas-warn">
                                                Unknown:
                                                ${unknown.map((name) => `{{${name}}}`).join(", ")}
                                            </p>`
                                          : null
                                  }
                                  <div class="x-personas-actions">
                                      <button
                                          type="button"
                                          class="button primary"
                                          disabled=${busy}
                                          onClick=${save}
                                      >
                                          Save
                                      </button>
                                      <button
                                          type="button"
                                          class="button"
                                          disabled=${busy}
                                          onClick=${() => setDraft(null)}
                                      >
                                          Close
                                      </button>
                                      ${
                                          draft.id === null
                                              ? null
                                              : confirmId === draft.id
                                                ? html`<span class="small"
                                                          >Delete this persona?</span
                                                      >
                                                      <button
                                                          type="button"
                                                          class="button"
                                                          disabled=${busy}
                                                          onClick=${() => remove(draft.id)}
                                                      >
                                                          Yes, delete
                                                      </button>
                                                      <button
                                                          type="button"
                                                          class="button"
                                                          disabled=${busy}
                                                          onClick=${() => setConfirmId(null)}
                                                      >
                                                          Keep
                                                      </button>`
                                                : html`<button
                                                      type="button"
                                                      class="button"
                                                      disabled=${busy}
                                                      onClick=${() => setConfirmId(draft.id)}
                                                  >
                                                      Delete
                                                  </button>`
                                      }
                                  </div>
                                  <p class="muted small">
                                      ${draft.content.length} characters. A change applies from Pi's
                                      next request in sessions that use this persona.
                                  </p>
                              </div>`
                    }
                </section>
            </div>
        </div>`;
    }

    /* ── What the module adds to the app ─────────────────────────────────────────────────────── */

    pocket.page({ id: "manage", title: "Personas", component: Manager });
    pocket.sheet({ id: "pick", title: "Choose a persona", component: Picker });
    pocket.menu({
        id: "pick",
        label: "Choose persona",
        hint: "this session",
        group: "session",
        sheet: "pick",
    });
    pocket.rail({ id: "manage", title: "Personas", iconPath: MASK, page: "manage" });
    pocket.menu({
        id: "manage",
        label: "Personas",
        hint: "system prompt",
        page: "manage",
    });
    pocket.launcher({
        id: "manage",
        label: "Personas",
        detail: "choose, edit, save",
        iconPath: MASK,
        page: "manage",
    });
    // The message box has less room on a phone: the status item and the session menu open the picker there, and the
    // composer button appears only where it fits.
    let composer = null;
    const wide = window.matchMedia("(min-width: 700px)");

    function syncComposer() {
        if (wide.matches) {
            if (composer === null && typeof pocket.composerButton === "function") {
                composer = pocket.composerButton({
                    id: "pick",
                    title: "Persona",
                    iconPath: MASK,
                    sheet: "pick",
                });
            }
        } else if (composer !== null) {
            composer.remove();
            composer = null;
        }
    }

    syncComposer();
    wide.addEventListener("change", syncComposer);

    if (typeof pocket.style === "function") {
        pocket.style("style.css");
    }

    return () => {
        wide.removeEventListener("change", syncComposer);
        composer?.remove();

        for (const stop of stops) {
            stop();
        }
    };
}
