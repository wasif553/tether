using System.Runtime.CompilerServices;

// Tether Windows Hardening v1.8.0, Phase A+B — lets the test project
// exercise the pure, internal KeyClassifier/ProtocolMessage classes
// directly, without making them public API surface for anything else
// that might reference this executable.
[assembly: InternalsVisibleTo("TetherKeyboardHelper.Tests")]
