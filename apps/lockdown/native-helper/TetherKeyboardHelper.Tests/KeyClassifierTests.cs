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
    private const uint VK_TAB = 0x09; // Alt+Tab is explicitly deferred to a later phase — Tab must pass through untouched in Phase A+B

    [Fact]
    public void Swallows_Left_Windows_key_keydown()
    {
        Assert.True(KeyClassifier.ShouldSwallow(VK_LWIN, isKeyDown: true, isKeyUp: false, ctrlHeld: false));
    }

    [Fact]
    public void Swallows_Left_Windows_key_keyup()
    {
        Assert.True(KeyClassifier.ShouldSwallow(VK_LWIN, isKeyDown: false, isKeyUp: true, ctrlHeld: false));
    }

    [Fact]
    public void Swallows_Right_Windows_key_keydown_and_keyup()
    {
        Assert.True(KeyClassifier.ShouldSwallow(VK_RWIN, isKeyDown: true, isKeyUp: false, ctrlHeld: false));
        Assert.True(KeyClassifier.ShouldSwallow(VK_RWIN, isKeyDown: false, isKeyUp: true, ctrlHeld: false));
    }

    [Fact]
    public void Windows_key_swallowed_regardless_of_Ctrl_state()
    {
        Assert.True(KeyClassifier.ShouldSwallow(VK_LWIN, isKeyDown: true, isKeyUp: false, ctrlHeld: true));
    }

    [Fact]
    public void Swallows_Escape_keydown_ONLY_while_Ctrl_is_held()
    {
        Assert.True(KeyClassifier.ShouldSwallow(VK_ESCAPE, isKeyDown: true, isKeyUp: false, ctrlHeld: true));
        Assert.False(KeyClassifier.ShouldSwallow(VK_ESCAPE, isKeyDown: true, isKeyUp: false, ctrlHeld: false));
    }

    [Fact]
    public void Does_not_swallow_Escape_keyup_even_while_Ctrl_is_held()
    {
        // The matching keydown was already swallowed — the keyup arrives
        // unpaired and is harmless to pass through (Escape carries no
        // "held" state) — see KeyboardHook.cs's own "stuck modifier" note.
        Assert.False(KeyClassifier.ShouldSwallow(VK_ESCAPE, isKeyDown: false, isKeyUp: true, ctrlHeld: true));
    }

    [Fact]
    public void Never_swallows_Ctrl_itself()
    {
        Assert.False(KeyClassifier.ShouldSwallow(VK_CONTROL, isKeyDown: true, isKeyUp: false, ctrlHeld: true));
        Assert.False(KeyClassifier.ShouldSwallow(VK_CONTROL, isKeyDown: false, isKeyUp: true, ctrlHeld: false));
    }

    [Fact]
    public void Does_not_swallow_Tab_Alt_Tab_blocking_is_deferred_to_a_later_phase()
    {
        Assert.False(KeyClassifier.ShouldSwallow(VK_TAB, isKeyDown: true, isKeyUp: false, ctrlHeld: false));
    }

    [Fact]
    public void Ordinary_unrelated_keys_always_pass_through()
    {
        Assert.False(KeyClassifier.ShouldSwallow(VK_A, isKeyDown: true, isKeyUp: false, ctrlHeld: false));
        Assert.False(KeyClassifier.ShouldSwallow(VK_A, isKeyDown: false, isKeyUp: true, ctrlHeld: true));
    }

    [Fact]
    public void An_event_that_is_neither_a_keydown_nor_a_keyup_edge_is_never_swallowed()
    {
        // Defensive — ShouldSwallow's contract requires the caller to
        // have already classified the Win32 message into one of these
        // two edges; passing neither must fail safe (pass through), never
        // throw or swallow by accident.
        Assert.False(KeyClassifier.ShouldSwallow(VK_LWIN, isKeyDown: false, isKeyUp: false, ctrlHeld: false));
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
        Assert.False(KeyClassifier.ShouldSwallow(VK_DELETE, isKeyDown: true, isKeyUp: false, ctrlHeld: true));
    }
}
