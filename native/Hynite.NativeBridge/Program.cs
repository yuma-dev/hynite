using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

var options = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
};

while (await Console.In.ReadLineAsync() is { } line)
{
    if (string.IsNullOrWhiteSpace(line))
    {
        continue;
    }

    try
    {
        var request = JsonSerializer.Deserialize<RpcRequest>(line, options);
        if (request is null)
        {
            continue;
        }

        object? result = request.Method switch
        {
            "resolveExecutable" => ResolveExecutable(request.Params),
            "launchGame" => LaunchGame(request.Params),
            "openFolder" => OpenFolder(request.Params),
            "encryptSecret" => EncryptSecret(request.Params),
            "decryptSecret" => DecryptSecret(request.Params),
            "watchProcess" => new { accepted = true },
            _ => throw new InvalidOperationException($"Unknown method {request.Method}.")
        };

        await WriteResponse(new RpcResponse(request.Id, result, null), options);
    }
    catch (Exception ex)
    {
        await WriteResponse(new RpcResponse(null, null, new RpcError(ex.Message)), options);
    }
}

static async Task WriteResponse(RpcResponse response, JsonSerializerOptions options)
{
    await Console.Out.WriteLineAsync(JsonSerializer.Serialize(response, options));
    await Console.Out.FlushAsync();
}

static object ResolveExecutable(JsonElement parameters)
{
    var path = parameters.GetProperty("path").GetString() ?? string.Empty;
    return new { path, exists = File.Exists(path) };
}

static object LaunchGame(JsonElement parameters)
{
    var command = parameters.TryGetProperty("command", out var commandElement) ? commandElement.GetString() : null;
    var executablePath = parameters.TryGetProperty("executablePath", out var exeElement) ? exeElement.GetString() : null;
    var workingDirectory = parameters.TryGetProperty("workingDirectory", out var workElement) ? workElement.GetString() : null;

    var target = !string.IsNullOrWhiteSpace(command) ? command : executablePath;
    if (string.IsNullOrWhiteSpace(target))
    {
        throw new InvalidOperationException("No launch command or executable path was provided.");
    }

    var startInfo = new ProcessStartInfo(target)
    {
        UseShellExecute = true
    };

    if (!string.IsNullOrWhiteSpace(workingDirectory) && Directory.Exists(workingDirectory))
    {
        startInfo.WorkingDirectory = workingDirectory;
    }

    var process = Process.Start(startInfo);
    return new
    {
        id = Guid.NewGuid().ToString("N"),
        pid = process?.Id,
        startedAt = DateTimeOffset.UtcNow.ToString("O")
    };
}

static object OpenFolder(JsonElement parameters)
{
    var path = parameters.GetProperty("path").GetString() ?? string.Empty;
    Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
    return new { ok = true };
}

static object EncryptSecret(JsonElement parameters)
{
    var value = parameters.GetProperty("value").GetString() ?? string.Empty;
    var bytes = Encoding.UTF8.GetBytes(value);
    var protectedBytes = ProtectedData.Protect(bytes, null, DataProtectionScope.CurrentUser);
    return new
    {
        cipherText = Convert.ToBase64String(protectedBytes),
        scope = "current-user"
    };
}

static object DecryptSecret(JsonElement parameters)
{
    var cipherText = parameters.GetProperty("cipherText").GetString() ?? string.Empty;
    var bytes = Convert.FromBase64String(cipherText);
    return Encoding.UTF8.GetString(ProtectedData.Unprotect(bytes, null, DataProtectionScope.CurrentUser));
}

public sealed record RpcRequest(string? Id, string Method, JsonElement Params);

public sealed record RpcResponse(string? Id, object? Result, RpcError? Error);

public sealed record RpcError(string Message);
