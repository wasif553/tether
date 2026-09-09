// @vitest-environment jsdom
/**
 * Spread watermark and enable Enter submit — component-level tests for
 * the Enter-to-submit change only: the free-text custom-prompt input/Ask
 * button was converted to a real <form onSubmit> so pressing Enter
 * submits exactly like clicking Ask (no separate keydown handler, no
 * second submission path). Starter actions/presets are UNCHANGED by this
 * task and are covered here only to prove they remain untouched.
 *
 * This repo's other component tests (see RecoveryStatusBanner.test.tsx)
 * call the component directly as a plain function and inspect the
 * returned element tree — that pattern only works for hookless
 * components. AiBrainstormPanel uses useState/useEffect/useRef/useId
 * extensively, so it genuinely needs a real render + DOM interaction to
 * test the Enter-key behaviour this task is about — jsdom and
 * @testing-library/react were added as devDependencies specifically for
 * this, scoped to this one file via the docblock above (the project's
 * default vitest environment, and every other test file's speed, is
 * unaffected).
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiBrainstormPanel } from "./AiBrainstormPanel";

const HISTORY_RESPONSE = {
  interactions: [],
  promptsRemainingForQuestion: 3,
  promptsRemainingForAttempt: 10,
  maxPromptsPerQuestion: 3,
  maxPromptsPerAttempt: 10,
};

const APPROVED_RESPONSE = {
  status: "APPROVED",
  response: "Some guidance.",
  studentMessage: null,
  promptsRemainingForQuestion: 2,
  promptsRemainingForAttempt: 9,
  maxPromptsPerQuestion: 3,
  maxPromptsPerAttempt: 10,
};

const EXPECTED_STARTER_LABELS = [
  "Help me understand the question",
  "Give me a starting point",
  "Ask me a guiding question",
  "Help me organise my ideas",
  "Challenge my reasoning",
  "Suggest what I should check",
];

function baseProps() {
  return {
    submissionId: "sub-1",
    questionId: "q-1",
    currentResponseText: null,
    questionNumber: 1,
    totalQuestions: 3,
    questionText: "Explain photosynthesis.",
  };
}

/** Queues one fake fetch response per call, in order; the final entry repeats for any extra calls. */
function mockFetchSequence(...bodies: unknown[]) {
  let call = 0;
  return vi.fn(async () => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return { ok: true, status: 200, json: async () => body } as Response;
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("11. starter actions remain unchanged (Spread watermark and enable Enter submit is UI-Enter-only)", () => {
  it("all six original starter buttons are still rendered, unchanged", async () => {
    vi.stubGlobal("fetch", mockFetchSequence(HISTORY_RESPONSE));
    render(<AiBrainstormPanel {...baseProps()} />);

    for (const label of EXPECTED_STARTER_LABELS) {
      expect(await screen.findByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("a starter button still sends its own unchanged prompt text via the same pipeline", async () => {
    const fetchMock = mockFetchSequence(HISTORY_RESPONSE, APPROVED_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AiBrainstormPanel {...baseProps()} />);

    await user.click(await screen.findByRole("button", { name: "Give me a starting point" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const postCall = fetchMock.mock.calls[1];
    expect(JSON.parse(postCall[1].body as string).studentPrompt).toBe(
      "Can you give me a broad starting point for approaching this?",
    );
  });
});

describe("AiBrainstormPanel — Enter-to-submit (Spread watermark and enable Enter submit)", () => {
  it("6. clicking Ask submits the typed custom prompt", async () => {
    const fetchMock = mockFetchSequence(HISTORY_RESPONSE, APPROVED_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AiBrainstormPanel {...baseProps()} />);

    const input = await screen.findByPlaceholderText("Ask your own question...");
    await user.type(input, "What is a thread?");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const postCall = fetchMock.mock.calls[1];
    expect(postCall[1].method).toBe("POST");
    expect(JSON.parse(postCall[1].body as string).studentPrompt).toBe("What is a thread?");
  });

  it("7. pressing Enter in the text input submits the same typed custom prompt", async () => {
    const fetchMock = mockFetchSequence(HISTORY_RESPONSE, APPROVED_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AiBrainstormPanel {...baseProps()} />);

    const input = await screen.findByPlaceholderText("Ask your own question...");
    await user.type(input, "What is a thread?{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const postCall = fetchMock.mock.calls[1];
    expect(postCall[1].method).toBe("POST");
    expect(JSON.parse(postCall[1].body as string).studentPrompt).toBe("What is a thread?");
  });

  it("8. a single Enter press creates only one request", async () => {
    const fetchMock = mockFetchSequence(HISTORY_RESPONSE, APPROVED_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AiBrainstormPanel {...baseProps()} />);

    const input = await screen.findByPlaceholderText("Ask your own question...");
    await user.type(input, "What is a thread?{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)); // 1 history GET + exactly 1 POST
    const postCalls = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST");
    expect(postCalls).toHaveLength(1);
  });

  it("9. empty input does not submit", async () => {
    const fetchMock = mockFetchSequence(HISTORY_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AiBrainstormPanel {...baseProps()} />);

    await screen.findByPlaceholderText("Ask your own question...");
    const askButton = screen.getByRole("button", { name: "Ask" });
    expect(askButton).toBeDisabled();
    await user.click(askButton);

    expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial history GET — no POST
  });

  it("10. disabled state (question limit reached) prevents submission even with text typed", async () => {
    const fetchMock = mockFetchSequence({ ...HISTORY_RESPONSE, promptsRemainingForQuestion: 0 });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AiBrainstormPanel {...baseProps()} />);

    const input = await screen.findByPlaceholderText("Ask your own question...");
    expect(input).toBeDisabled();
    await user.type(input, "Trying anyway"); // typing into a disabled input is a no-op
    expect(input).toHaveValue("");
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();

    expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial history GET — no POST
  });
});
