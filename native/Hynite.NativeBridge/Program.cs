using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SteamKit2;

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

    string? requestId = null;
    try
    {
        var request = JsonSerializer.Deserialize<RpcRequest>(line, options);
        if (request is null)
        {
            continue;
        }

        requestId = request.Id;
        object? result = request.Method switch
        {
            "resolveExecutable" => ResolveExecutable(request.Params),
            "launchGame" => LaunchGame(request.Params),
            "openFolder" => OpenFolder(request.Params),
            "encryptSecret" => EncryptSecret(request.Params),
            "decryptSecret" => DecryptSecret(request.Params),
            "steamGetAppInfo" => await SteamAppInfoClient.GetAppInfo(request.Params),
            "watchProcess" => new { accepted = true },
            _ => throw new InvalidOperationException($"Unknown method {request.Method}.")
        };

        await WriteResponse(new RpcResponse(request.Id, result, null), options);
    }
    catch (Exception ex)
    {
        await WriteResponse(new RpcResponse(requestId, null, new RpcError(ex.Message)), options);
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

public sealed class SteamAppInfoClient : IDisposable
{
    private readonly SteamClient steamClient = new();
    private readonly CallbackManager callbackManager;
    private readonly SteamUser steamUser;
    private readonly SteamApps steamApps;
    private readonly CancellationTokenSource callbackLoopCancellation = new();
    private Task? callbackLoopTask;
    private TaskCompletionSource<EResult>? connectedCompletion;
    private TaskCompletionSource<EResult>? loggedOnCompletion;
    private bool connected;
    private bool loggedOn;

    private static readonly Lazy<SteamAppInfoClient> Shared = new(() => new SteamAppInfoClient());
    private static readonly SemaphoreSlim ConnectionLock = new(1, 1);

    private SteamAppInfoClient()
    {
        callbackManager = new CallbackManager(steamClient);
        steamUser = steamClient.GetHandler<SteamUser>() ?? throw new InvalidOperationException("Steam user handler is unavailable.");
        steamApps = steamClient.GetHandler<SteamApps>() ?? throw new InvalidOperationException("Steam apps handler is unavailable.");
        callbackManager.Subscribe<SteamClient.ConnectedCallback>(OnConnected);
        callbackManager.Subscribe<SteamClient.DisconnectedCallback>(OnDisconnected);
        callbackManager.Subscribe<SteamUser.LoggedOnCallback>(OnLoggedOn);
        callbackManager.Subscribe<SteamUser.LoggedOffCallback>(_ => loggedOn = false);
    }

    public static async Task<object?> GetAppInfo(JsonElement parameters)
    {
        var appid = parameters.GetProperty("appid").GetUInt32();
        var language = parameters.TryGetProperty("language", out var languageElement) ? languageElement.GetString() : "english";
        var values = await Shared.Value.GetProductInfo(appid, language ?? "english");
        return MapAppInfo(appid, values);
    }

    private async Task<KeyValue> GetProductInfo(uint appid, string language)
    {
        await EnsureConnected(language);
        var productJob = steamApps.PICSGetProductInfo(new SteamApps.PICSRequest(appid, 0), package: null, metaDataOnly: false);
        var resultSet = await productJob.ToTask().WaitAsync(TimeSpan.FromSeconds(15));
        var results = resultSet.Results ?? [];
        var productInfo = resultSet.Complete
            ? results.FirstOrDefault()
            : results.FirstOrDefault(result => result.Apps.ContainsKey(appid));

        if (productInfo is null || !productInfo.Apps.TryGetValue(appid, out var appInfo))
        {
            throw new InvalidOperationException($"Steam appinfo did not include app {appid}.");
        }

        return appInfo.KeyValues;
    }

    private async Task EnsureConnected(string language)
    {
        StartCallbackLoop();
        if (connected && loggedOn)
        {
            return;
        }

        await ConnectionLock.WaitAsync();
        try
        {
            if (!connected)
            {
                connectedCompletion = new TaskCompletionSource<EResult>(TaskCreationOptions.RunContinuationsAsynchronously);
                steamClient.Connect();
                var connect = await connectedCompletion.Task.WaitAsync(TimeSpan.FromSeconds(15));
                if (connect != EResult.OK)
                {
                    throw new InvalidOperationException($"Steam anonymous connection failed: {connect}.");
                }
            }

            if (!loggedOn)
            {
                loggedOnCompletion = new TaskCompletionSource<EResult>(TaskCreationOptions.RunContinuationsAsynchronously);
                steamUser.LogOnAnonymous(new SteamUser.AnonymousLogOnDetails { ClientLanguage = language });
                var logon = await loggedOnCompletion.Task.WaitAsync(TimeSpan.FromSeconds(15));
                if (logon != EResult.OK)
                {
                    throw new InvalidOperationException($"Steam anonymous login failed: {logon}.");
                }
            }
        }
        finally
        {
            ConnectionLock.Release();
        }
    }

    private void StartCallbackLoop()
    {
        if (callbackLoopTask is not null)
        {
            return;
        }

        callbackLoopTask = Task.Run(() =>
        {
            while (!callbackLoopCancellation.IsCancellationRequested)
            {
                callbackManager.RunWaitCallbacks(TimeSpan.FromSeconds(1));
            }
        }, callbackLoopCancellation.Token);
    }

    private void OnConnected(SteamClient.ConnectedCallback callback)
    {
        connected = true;
        connectedCompletion?.TrySetResult(EResult.OK);
    }

    private void OnDisconnected(SteamClient.DisconnectedCallback _)
    {
        connected = false;
        loggedOn = false;
    }

    private void OnLoggedOn(SteamUser.LoggedOnCallback callback)
    {
        loggedOn = callback.Result == EResult.OK;
        loggedOnCompletion?.TrySetResult(callback.Result);
    }

    private static object MapAppInfo(uint appid, KeyValue values)
    {
        var common = values["common"];
        return new
        {
            appid,
            name = Value(common["name"]),
            type = Value(common["type"]),
            parent = Value(common["parent"]),
            clienticon = Value(common["clienticon"]),
            icon = Value(common["icon"]),
            steamReleaseDate = Value(common["steam_release_date"]),
            headerImage = LocalizedValues(common["header_image"]),
            smallCapsule = LocalizedValues(common["small_capsule"]),
            associations = Associations(common["associations"]),
            libraryAssetsFull = new
            {
                libraryCapsule = MapLibraryAsset(common["library_assets_full"]["library_capsule"]),
                libraryHero = MapLibraryAsset(common["library_assets_full"]["library_hero"]),
                libraryLogo = MapLibraryAsset(common["library_assets_full"]["library_logo"])
            },
            libraryAssets = Children(common["library_assets"]),
            storeTags = Children(common["store_tags"]),
            extended = Children(values["extended"])
        };
    }

    private static object MapLibraryAsset(KeyValue asset)
    {
        return new
        {
            image = LocalizedValues(asset["image"]),
            image2x = LocalizedValues(asset["image2x"])
        };
    }

    private static string? Value(KeyValue value)
    {
        return string.IsNullOrWhiteSpace(value.Value) ? null : value.Value;
    }

    private static Dictionary<string, string> LocalizedValues(KeyValue value)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!string.IsNullOrWhiteSpace(value.Value))
        {
            result["english"] = value.Value;
        }

        foreach (var child in value.Children)
        {
            if (!string.IsNullOrWhiteSpace(child.Name) && !string.IsNullOrWhiteSpace(child.Value))
            {
                result[child.Name] = child.Value;
            }
        }

        return result;
    }

    private static Dictionary<string, string> Children(KeyValue value)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var child in value.Children)
        {
            if (!string.IsNullOrWhiteSpace(child.Name) && !string.IsNullOrWhiteSpace(child.Value))
            {
                result[child.Name] = child.Value;
            }
        }

        return result;
    }

    private static object[] Associations(KeyValue value)
    {
        var result = new List<object>();
        foreach (var child in value.Children)
        {
            var name = Value(child["name"]);
            var type = Value(child["type"]);
            if (!string.IsNullOrWhiteSpace(name) || !string.IsNullOrWhiteSpace(type))
            {
                result.Add(new { name, type });
            }
        }

        return result.ToArray();
    }

    public void Dispose()
    {
        callbackLoopCancellation.Cancel();
        steamClient.Disconnect();
        callbackLoopCancellation.Dispose();
    }
}
