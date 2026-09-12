using TetherKeyboardHelper;
using Xunit;

namespace TetherKeyboardHelper.Tests;

public class ProtocolMessageTests
{
    [Fact]
    public void Parses_HELLO_with_token()
    {
        var message = ProtocolMessage.Parse("{\"type\":\"HELLO\",\"token\":\"abc123\"}");
        Assert.NotNull(message);
        Assert.Equal("HELLO", message!.Type);
        Assert.Equal("abc123", message.Token);
    }

    [Fact]
    public void Parses_ARM_with_no_extra_fields()
    {
        var message = ProtocolMessage.Parse("{\"type\":\"ARM\"}");
        Assert.NotNull(message);
        Assert.Equal("ARM", message!.Type);
        Assert.Null(message.Token);
        Assert.Null(message.Reason);
    }

    [Fact]
    public void Parses_DISARM_PING_SHUTDOWN()
    {
        Assert.Equal("DISARM", ProtocolMessage.Parse("{\"type\":\"DISARM\"}")!.Type);
        Assert.Equal("PING", ProtocolMessage.Parse("{\"type\":\"PING\"}")!.Type);
        Assert.Equal("SHUTDOWN", ProtocolMessage.Parse("{\"type\":\"SHUTDOWN\"}")!.Type);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("")]
    [InlineData("{")]
    [InlineData("[1,2,3]")]
    [InlineData("42")]
    [InlineData("null")]
    [InlineData("{\"token\":\"abc\"}")] // missing type
    [InlineData("{\"type\":123}")] // type not a string
    public void Rejects_malformed_or_incomplete_input_without_throwing(string line)
    {
        var message = ProtocolMessage.Parse(line);
        Assert.Null(message);
    }

    [Fact]
    public void Rejects_a_line_over_the_bounded_length()
    {
        var oversized = new string('a', 2000);
        var message = ProtocolMessage.Parse($"{{\"type\":\"HELLO\",\"token\":\"{oversized}\"}}");
        Assert.Null(message);
    }

    [Fact]
    public void Rejects_null_input()
    {
        Assert.Null(ProtocolMessage.Parse(null));
    }

    [Fact]
    public void Serialize_round_trips_through_Parse()
    {
        var original = new ProtocolMessage("ARM_FAILED", reason: "HOOK_INSTALL_FAILED");
        var serialized = original.Serialize();
        var parsed = ProtocolMessage.Parse(serialized);
        Assert.NotNull(parsed);
        Assert.Equal("ARM_FAILED", parsed!.Type);
        Assert.Equal("HOOK_INSTALL_FAILED", parsed.Reason);
    }

    [Fact]
    public void Serialize_omits_null_token_and_reason_fields_entirely_rather_than_emitting_them_as_null()
    {
        var serialized = new ProtocolMessage("ARMED").Serialize();
        Assert.DoesNotContain("token", serialized);
        Assert.DoesNotContain("reason", serialized);
    }
}
