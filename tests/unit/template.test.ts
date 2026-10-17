import "../setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate, renderSubjectAndBody } from "../../src/utils/template.js";

test("substitutes {{name}} and {{email}}", () => {
  const rendered = renderTemplate("Hi {{name}} <{{email}}>", {
    name: "Alice",
    email: "alice@example.com",
  });
  assert.equal(rendered, "Hi Alice <alice@example.com>");
});

test("tolerates whitespace inside the braces", () => {
  assert.equal(renderTemplate("Hi {{  name  }}", { name: "Bob", email: "b@x.com" }), "Hi Bob");
});

test("a missing name renders as an empty string", () => {
  assert.equal(renderTemplate("Hi {{name}}!", { name: null, email: "a@x.com" }), "Hi !");
  assert.equal(renderTemplate("Hi {{name}}!", { email: "a@x.com" }), "Hi !");
});

test("unknown tokens pass through untouched", () => {
  assert.equal(
    renderTemplate("Hi {{firstName}}", { name: "Alice", email: "a@x.com" }),
    "Hi {{firstName}}",
  );
});

test("renders subject and body together", () => {
  const result = renderSubjectAndBody("Hello {{name}}", "To {{email}}", {
    name: "Alice",
    email: "alice@example.com",
  });
  assert.deepEqual(result, {
    subject: "Hello Alice",
    body: "To alice@example.com",
  });
});
