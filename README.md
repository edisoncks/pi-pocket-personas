# Pi Pocket Personas

Saved system-prompt fragments that the owner chooses for one session. The chosen persona is appended to Pi's system
prompt for that session, from the next model request on. Each session can have a persona, or none.

## Install

Copy the module and its browser folder into Pi Pocket's drop-in folder:

```sh
cp pi-pocket-personas.ts ~/.pi-pocket/extensions/
cp -r personas-ui ~/.pi-pocket/extensions/
```

Then turn it on in **Menu → Extensions → Pi Pocket Personas**. A drop-in starts off. The browser module loads in the
tab at its next reload.

The default for new sessions needs Pi Pocket 0.20.0 or newer (the session list); this version was tested on 0.22.0.

### Upgrading from `personas.ts`

The first version was the single file `personas.ts` with the folder `personas/`. Remove both, then install as above:

```sh
rm -rf ~/.pi-pocket/extensions/personas.ts ~/.pi-pocket/extensions/personas
```

The document kinds are unchanged (`x.personas.catalog`, `x.personas.active`), so saved personas, the default, and each
session's choice are still there. The extension's internal name changed to `pi-pocket-personas`; a conversation that
explicitly selected the old `my-personas` extension may need it selected again. Pi Pocket's default is every installed
extension, so most sessions need nothing.

## Files

```
pi-pocket-personas.ts          the module: the prompt section, the routes, and /persona-use
personas-ui/
    index.js                   the page, the picker sheet, the rail button, and the status item
    style.css                  the page's and picker's look
pi-pocket-personas.test.ts     routes, the section, the command, a restart, the default, migration, off/on
pi-pocket-personas-ui.test.ts  the same flow in a real Chromium
_pocket.d.ts                   a copy of Pi Pocket 0.22.0's public types, for `npm run check`
```

This file is the module that goes into `extensions/`; `_pocket.d.ts` is only for the repo's type check. The drop-in
folder already has its own `_pocket.d.ts` symlink.

## Use

- **Message box → Persona** opens the picker. The first row is **No persona**.
- **Status line** shows `persona: <name>`, or `no persona` muted, after the costs; a tap opens the picker.
- **Rail → Personas**, **Menu → Personas**, or `Ctrl/⌘+K → Personas` opens the manager. The rail uses a theatre-mask
  icon, distinct from the app's people and invites icons.
- `/persona-use Terse reviewer` chooses one; `/persona-use off` clears it; `/persona-use` lists the names.
- **Default for new sessions** in the manager sets what a session starts with, including **No persona**.

A change applies from Pi's next request. A run already in flight keeps the prompt it started with. Past messages are
not rewritten.

## The default for new sessions

The manager's **Default for new sessions** is saved with the catalog. It applies to sessions that have no choice of
their own; a session that chose a persona, or chose **No persona**, keeps its choice.

When the default changes, the route pins every session without a choice to the persona it used before the change. Thus
only sessions made from then on start with the new default. Sessions that had the old default keep it; sessions that
had none keep none.

- The default is per data folder, like the catalog, not per person.
- Deleting the persona that is the default clears the default. Sessions that used it fall back to no persona.
- The manager reports how many sessions kept what they had when the default changed.
- A session's picker says `Default for new sessions: <name>` while it inherits; after a choice, it does not.

## Variables in persona text

A persona can use placeholders. They are filled when the section renders, before each request, so the stored text keeps
the placeholder:

| Placeholder    | Value                                                              |
| -------------- | ------------------------------------------------------------------ |
| `{{model}}`    | The model's display name, or `provider/modelId` when it is unknown |
| `{{provider}}` | The provider, such as `anthropic`                                  |
| `{{model_id}}` | The model's id, without the provider                               |
| `{{cwd}}`      | The session's folder, as a full path                               |
| `{{project}}`  | That folder's name                                                 |
| `{{thinking}}` | The thinking level, such as `off` or `high`                        |
| `{{date}}`     | Today, as `YYYY-MM-DD`, in UTC                                     |
| `{{platform}}` | The server's operating system, such as `linux`                     |
| `{{session}}`  | The session's id                                                   |
| `{{persona}}`  | The persona's own name                                             |

- Names are case-insensitive and may have spaces inside the braces: `{{ cwd }}` works.
- A name the module does not know stays exactly as typed. The manager shows a warning for it.
- Write `\{{` for a literal `{{`, for persona text that shows a template of its own.
- `{{date}}` changes once a day; the others change when the session's model, folder, or thinking level changes. Only
  the persona section is sent again when one changes; the rest of the prompt stays cached.
- The values are not stored in the persona. A shared persona can say `{{cwd}}` instead of one machine's path.

## Where the data lives

Both documents are in `pocket.sqlite` in the data folder (`~/.pi-pocket/` by default), not in this folder:

- `x.personas.catalog` — scope `session` (the whole data folder), version 2: the saved personas and
  `defaultPersonaId`. Version 1 migrates to it with the default cleared.
- `x.personas.active` — scope `conversation`, the choice for each session; `fork: "current"` keeps it in a fork.

Turning the module off keeps both. Turning it on again finds the same choices. Deleting a persona makes every session
that used it have no persona. Do not rename the kinds or change their scope, history, or fork once there is data.

## Who may use it

The routes and the browser module are for the owner alone, the default. A guest or viewer does not see the rail
button, the picker, or the status item.

To let guests who can steer a session choose a persona, widen all three:

```ts
web.client("personas-ui", { access: "view" }); // or "steer"
web.route("GET", "state/:session", handler, { access: "view" });
web.route("PUT", "active/:session", handler, { access: "steer" });
```

and change the command's `scope` to `"conversation"`. Keep the catalog routes (`GET catalog`, `POST personas`,
`DELETE personas/:id`) owner-only: guests can choose a persona, but not edit or delete one. The manager page fetches
the catalog, so a guest sees its error; use the picker alone for guests.

## Test

The tests use a temporary data folder and a scripted model; they never touch the real data. They expect a Pi Pocket
checkout beside this repo, at `../pi-pocket`; change the import paths at the top of each test if yours is elsewhere.

```sh
npm install
npm test
npm run check
```

The UI test needs a Chromium that Pi Pocket can find. `npm run check` checks the module against `_pocket.d.ts`.

## License

No license yet. Add one before you share the repo or publish it to the gallery.
