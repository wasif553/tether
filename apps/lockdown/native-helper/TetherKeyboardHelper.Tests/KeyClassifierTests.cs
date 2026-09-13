using TetherKeyboardHelper;
using Xunit;

namespace TetherKeyboardHelper.Tests;

public class KeyClassifierTests
{
    private const uint VK_LWIN = 0x5B;
    private const uint VK_RWIN = 0x5C;
    private const uint VK_ESCAPE = 0x1B;
    private const uint VK_A = 0x41; // an arbitrary, unrelated ordinary key
    private const uint VK_CONTROL = 0x11; // Ctrl itself must never be swallowed
    private const uint VK_TAB = 0x09;

    [Fact]
    public void Swallows_Left_Windows_key_keydown()
    {
        Assert.True(KeyClassifier.ShouldSwallow(VK_LWIN, isKeyDown: true, isKeyUp: false, ctrlHeld: false, altHeld: false));
    }

    [Fact]
    public void Swallows_Left_Windows_key_keyup()
    {
        Assert.True(KeyClassifier.ShouldSwallow(VK_LWIN, isKeyDown: false, isKeyUp: true, ctrlHeld: false, altHeld: false));
    }

    [Fact]
    public void Swallows_Right_Windows_key_keydown_and_keyup()
    {
        Assert.True(KeyClassifier.ShouldSwallow(VK_RWIN, isKeyDown: true, isKeyUp: false, ctrlHeld: false, altHeld: false));
        Assert.True(KeyClassifier.ShouldSwallow(VK_RWIN, isKeyDown: false, isKeyUp: true, ctrlHeld: false, altHeld: false));
    }

    [Fact]
    public void Windows_key_swallowed_regardless_of_Ctrl_state()
    {
        Assert.True(KeyClassifier.ShouldSwallow(VK_LWIN, isKeyDown: true, isKeyUp: false, ctrlHeld: true, altHeld: false));
    }

    // --- Phase A+B regression: Ctrl+Esc (unchanged) ---

    [Fact]
    public void Swallows_Escape_keydown_ONLY_while_Ctrl_is_held()
    {
        Assert.True(KeyClassifier.ShouldSwallow(VK_ESCAPE, isKeyDown: true, isKeyUp: false, ctrlHeld: true, altHeld: false));
        Assert.False(KeyClassifier.ShouldSwallow(VK_ESCAPE, isKeyDown: true, isKeyUp: false, ctrlHeld: false, altHeld: false));
    }

    [Fact]
    public void Does_not_swallow_Escape_keyup_even_while_Ctrl_is_held()
    {
        // The matching keydown was already swallowed — the keyup arrives
        // unpaired and is harmless to pass through (Escape carries no
        // "held" state) — see KeyboardHook.cs's own "stuck modifier" note.
        Assert.False(KeyClassifier.ShouldSwallow(VK_ESCAPE, isKeyDown: false, isKeyUp: true, ctrlHeld: true, altHeld: false));
    }

    [Fact]
    public void Never_swallows_Ctrl_itself()
    {
        Assert.False(KeyClassifier.ShouldSwallow(VK_CONTROL, isKeyDown: true, isKeyUp: false, ctrlHeld: true, altHeld: false));
        Assert.False(KeyClassifier.ShouldSwallow(VK_CONTROL, isKeyDown: false, isKeyUp: true, ctrlHeld: false, altHeld: false));
    }

    [Fact]
    public void Ordinary_unrelated_keys_always_pass_through()
    {
        Assert.False(KeyClassifier.ShouldSwallow(VK_A, isKeyDown: true, isKeyUp: false, ctrlHeld: false, altHeld: false));
        Assert.False(KeyClassifier.ShouldSwallow(VK_A, isKeyDown: false, isKeyUp: true, ctrlHeld: true, altHeld: false));
    }

    [Fact]
    public void An_event_that_is_neither_a_keydown_nor_a_keyup_edge_is_never_swallowed()
    {
        // Defensive — ShouldSwallow's contract requires the caller to
        // have already classified the Win32 message into one of these
        // two edges; passing neither must fail safe (pass through), never
        // throw or swallow by accident.
        Assert.False(KeyClassifier.ShouldSwallow(VK_LWIN, isKeyDown: false, isKeyUp: false, ctrlHeld: false, altHeld: false));
    }

    [Fact]
    public void This_classifier_has_no_representation_of_Ctrl_Alt_Delete_whatsoever()
    {
        // There is no VK_DELETE case anywhere in KeyClassifier — Windows'
        // Secure Attention Sequence never reaches this process at all
        // (see KeyboardHook.cs's own doc comment), so there is nothing
        // for this classifier to special-case. This test exists purely
        // to make that omission an explicit, checked assertion rather
        // than a silent absence: even Ctrl+Alt+Delete's own Delete
        // keydown, if it somehow reached this callback, would fall
        // through to "not swallowed" like any other ordinary key.
        const uint VK_DELETE = 0x2E;
        Assert.False(KeyClassifier.ShouldSwallow(VK_DELETE, isKeyDown: true, isKeyUp: false, ctrlHeld: true, altHeld: true));
    }

    // --- Phase C (v1.8.1): Tab/Escape while Alt is held ---
    // altHeld models KBDLLHOOKSTRUCT.flags' LLKHF_ALTDOWN bit — see
    // NativeMethods.cs and KeyboardHook.cs for how it's actually derived
    // from a real event; this test file only ever exercises the pure
    // decision function.

    [Fact]
    public void Alt_Tab_keydown_is_swallowed()
    {
        Assert.True(KeyClassifier.ShouldSwallow(VK_TAB, isKeyDown: true, isKeyUp: false, ctrlHeld: false, altHeld: true));
    }

    [Fact]
    public void Alt_Tab_keyup_is_also_swallowed_both_edges_together_like_the_Windows_key()
    {
        Assert.True(KeyClassifier.ShouldSwallow(VK_TAB, isKeyDown: false, isKeyUp: true, ctrlHeld: false, altHeld: true));
    }

    [Fact]
    public void Shift_Alt_Tab_is_swallowed()
    {
        // The classifier has no shiftHeld parameter at all: the Tab+Alt
        // rule is gated on altHeld alone, so Shift being simultaneously
        // held is irrelevant to it and Shift+Alt+Tab is covered by the
        // exact same case as plain Alt+Tab — this test exists to make
        // that "Shift doesn't matter here" property an explicit assertion.
        Assert.True(KeyClassifier.ShouldSwallow(VK_TAB, isKeyDown: true, isKeyUp: false, ctrlHeld: false, altHeld: true));
        Assert.True(KeyClassifier.ShouldSwallow(VK_TAB, isKeyDown: false, isKeyUp: true, ctrlHeld: false, altHeld: true));
    }

    [Fact]
    public void Ctrl_Alt_Tab_is_swallowed()
    {
        // Covers the persistent on-screen task switcher (Ctrl+Alt+Tab),
        // which is still just Tab-while-Alt-held from this classifier's
        // point of view — ctrlHeld being simultaneously true must not
        // suppress the Tab+Alt rule.
        Assert.True(KeyClassifier.ShouldSwallow(VK_TAB, isKeyDown: true, isKeyUp: false, ctrlHeld: true, altHeld: true));
        Assert.True(KeyClassifier.ShouldSwallow(VK_TAB, isKeyDown: false, isKeyUp: true, ctrlHeld: true, altHeld: true));
    }

    [Fact]
    public void Tab_alone_without_Alt_is_never_swallowed()
    {
        // Ordinary in-page Tab navigation (moving focus between form
        // fields/answers) must keep working normally — only Tab-while-
        // Alt-held is a task-switch signal.
        Assert.False(KeyClassifier.ShouldSwallow(VK_TAB, isKeyDown: true, isKeyUp: false, ctrlHeld: false, altHeld: false));
        Assert.False(KeyClassifier.ShouldSwallow(VK_TAB, isKeyDown: false, isKeyUp: true, ctrlHeld: false, altHeld: false));
        // Also unaffected by Ctrl/Shift alone (no Alt) — ordinary Ctrl+Tab
        // (e.g. browser-style tab-switching within the page) is out of
        // this rule's scope entirely.
        Assert.False(KeyClassifier.ShouldSwallow(VK_TAB, isKeyDown: true, isKeyUp: false, ctrlHeld: true, altHeld: false));
    }

    [Fact]
    public void Alt_Esc_keydown_is_swallowed()
    {
        Assert.True(KeyClassifier.ShouldSwallow(VK_ESCAPE, isKeyDown: true, isKeyUp: false, ctrlHeld: false, altHeld: true));
    }

    [Fact]
    public void Alt_Esc_keyup_is_NOT_swallowed_matching_the_existing_Ctrl_Esc_design()
    {
        // Same reasoning as Does_not_swallow_Escape_keyup_even_while_Ctrl_is_held:
        // the matching keydown was already swallowed, and Escape carries
        // no "held" state for the unpaired keyup to corrupt.
        Assert.False(KeyClassifier.ShouldSwallow(VK_ESCAPE, isKeyDown: false, isKeyUp: true, ctrlHeld: false, altHeld: true));
    }

    [Fact]
    public void Escape_alone_without_Ctrl_or_Alt_is_never_swallowed()
    {
        Assert.False(KeyClassifier.ShouldSwallow(VK_ESCAPE, isKeyDown: true, isKeyUp: false, ctrlHeld: false, altHeld: false));
    }

    [Fact]
    public void Alt_plus_an_unrelated_ordinary_key_is_never_swallowed()
    {
        // altHeld must only ever affect Tab and Escape — no other key
        // combination becomes newly swallowed just because Alt is down
        // (e.g. Alt+A, or any other ordinary in-page Alt shortcut).
        Assert.False(KeyClassifier.ShouldSwallow(VK_A, isKeyDown: true, isKeyUp: false, ctrlHeld: false, altHeld: true));
        Assert.False(KeyClassifier.ShouldSwallow(VK_A, isKeyDown: false, isKeyUp: true, ctrlHeld: false, altHeld: true));
    }

    [Fact]
    public void Alt_itself_is_never_swallowed()
    {
        // Phase C never inspects or swallows VK_MENU/VK_LMENU/VK_RMENU —
        // Alt's own down/up events are not classified at all here, only
        // read via the flags-derived altHeld signal at the call site.
        const uint VK_MENU = 0x12;
        const uint VK_LMENU = 0xA4;
        const uint VK_RMENU = 0xA5;
        Assert.False(KeyClassifier.ShouldSwallow(VK_MENU, isKeyDown: true, isKeyUp: false, ctrlHeld: false, altHeld: true));
        Assert.False(KeyClassifier.ShouldSwallow(VK_LMENU, isKeyDown: true, isKeyUp: false, ctrlHeld: false, altHeld: true));
        Assert.False(KeyClassifier.ShouldSwallow(VK_RMENU, isKeyDown: false, isKeyUp: true, ctrlHeld: false, altHeld: true));
    }
}
