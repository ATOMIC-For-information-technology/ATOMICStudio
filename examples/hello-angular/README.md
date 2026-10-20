# Hello Angular — ATOMIC Studio Example

A minimal Angular project demonstrating ATOMIC Studio's **click-to-edit** support for Angular components.

## Features Demonstrated

1. **External HTML Templates (`.component.html`)**:
   - `src/app/app.component.html` contains heading, counter box, and button.
   - Clicking `<h1 ...>`, `<p ...>`, or `<button (click)="increment()">` in the live preview resolves to the exact line in `src/app/app.component.html`.

2. **Inline Component Templates (`.component.ts`)**:
   - `src/app/inline-card.component.ts` defines an inline template via the `@Component({ template: \`...\` })` decorator.
   - Clicking elements within the card maps to their exact source line inside `src/app/inline-card.component.ts`.

3. **Event Bindings & Nested Components**:
   - Demonstrates event binding `(click)="increment()"`.
   - Demonstrates nested component `<app-inline-card>` rendered within the parent template.

## Running in ATOMIC Studio

1. Open ATOMIC Studio.
2. Open the `examples/hello-angular` directory.
3. Click **Run** in the toolbar to start the development preview server.
4. Toggle **Select element** (cursor icon) in the preview toolbar.
5. Click on:
   - The **"Hello from Angular..."** heading to jump to `src/app/app.component.html` line 2.
   - The **"Click me"** button to jump to `src/app/app.component.html` line 10.
   - The **"Inline Template Component"** card to jump to `src/app/inline-card.component.ts` line 7.
