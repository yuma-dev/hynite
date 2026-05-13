using System.Diagnostics;
using System.Runtime.InteropServices;
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
            "getFileVersionInfo" => GetFileVersionInfo(request.Params),
            "getPrefetchLastRunTimes" => GetPrefetchLastRunTimes(request.Params),
            "watchProcess" => new { accepted = true },
            "pollGamepad" => PollGamepad(),
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

static object GetFileVersionInfo(JsonElement parameters)
{
    var paths = new List<string>();
    if (parameters.TryGetProperty("paths", out var pathsElement) && pathsElement.ValueKind == JsonValueKind.Array)
    {
        foreach (var element in pathsElement.EnumerateArray())
        {
            var path = element.GetString();
            if (!string.IsNullOrWhiteSpace(path))
            {
                paths.Add(path);
            }
        }
    }

    var results = new List<object>();
    foreach (var path in paths)
    {
        try
        {
            if (!File.Exists(path))
            {
                results.Add(new { path, exists = false });
                continue;
            }

            var info = FileVersionInfo.GetVersionInfo(path);
            var size = new FileInfo(path).Length;
            results.Add(new
            {
                path,
                exists = true,
                size,
                productName = NullIfBlank(info.ProductName),
                fileDescription = NullIfBlank(info.FileDescription),
                fileVersion = NullIfBlank(info.FileVersion),
                productVersion = NullIfBlank(info.ProductVersion),
                companyName = NullIfBlank(info.CompanyName),
                originalFilename = NullIfBlank(info.OriginalFilename),
                internalName = NullIfBlank(info.InternalName),
                legalCopyright = NullIfBlank(info.LegalCopyright)
            });
        }
        catch (Exception ex)
        {
            results.Add(new { path, exists = true, error = ex.Message });
        }
    }

    return new { results };
}

static object PollGamepad() => XInputReader.Poll();

static object GetPrefetchLastRunTimes(JsonElement parameters)
{
    var requested = new List<(string Path, string ExeName)>();
    if (parameters.TryGetProperty("paths", out var pathsEl) && pathsEl.ValueKind == JsonValueKind.Array)
    {
        foreach (var el in pathsEl.EnumerateArray())
        {
            var p = el.GetString();
            if (string.IsNullOrWhiteSpace(p))
                continue;

            var exeName = Path.GetFileName(p);
            if (!string.IsNullOrWhiteSpace(exeName))
                requested.Add((p, exeName.ToUpperInvariant()));
        }
    }

    var prefetchDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Prefetch");

    var latestByExeName = new Dictionary<string, DateTimeOffset>(StringComparer.OrdinalIgnoreCase);
    if (requested.Count > 0 && Directory.Exists(prefetchDir))
    {
        var requestedNames = requested.Select(item => item.ExeName).ToHashSet(StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (var pfFile in Directory.EnumerateFiles(prefetchDir, "*.pf"))
            {
                var stem = Path.GetFileNameWithoutExtension(pfFile);
                var separatorIndex = stem.LastIndexOf('-');
                if (separatorIndex <= 0)
                    continue;

                var exeName = stem[..separatorIndex];
                if (!requestedNames.Contains(exeName))
                    continue;

                var mtime = new DateTimeOffset(File.GetLastWriteTimeUtc(pfFile), TimeSpan.Zero);
                if (!latestByExeName.TryGetValue(exeName, out var latest) || mtime > latest)
                    latestByExeName[exeName] = mtime;
            }
        }
        catch { }
    }

    var results = requested.Select(item =>
    {
        string? lastRunAt = latestByExeName.TryGetValue(item.ExeName, out var latest)
            ? latest.UtcDateTime.ToString("O")
            : null;
        return new { path = item.Path, lastRunAt };
    }).ToList();

    return new { results };
}

static string? NullIfBlank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;

static object DecryptSecret(JsonElement parameters)
{
    var cipherText = parameters.GetProperty("cipherText").GetString() ?? string.Empty;
    var bytes = Convert.FromBase64String(cipherText);
    return Encoding.UTF8.GetString(ProtectedData.Unprotect(bytes, null, DataProtectionScope.CurrentUser));
}

public sealed record RpcRequest(string? Id, string Method, JsonElement Params);

// XInput P/Invoke — works regardless of window focus, unlike the Chromium Gamepad API.
internal static class XInputReader
{
    [DllImport("xinput1_4.dll", EntryPoint = "XInputGetState")]
    private static extern uint XInputGetState(uint dwUserIndex, out XInputState pState);

    [StructLayout(LayoutKind.Sequential)]
    private struct XInputState
    {
        public uint dwPacketNumber;
        public XInputGamepad Gamepad;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct XInputGamepad
    {
        [FieldOffset(0)] public ushort wButtons;
        [FieldOffset(2)] public byte bLeftTrigger;
        [FieldOffset(3)] public byte bRightTrigger;
        [FieldOffset(4)] public short sThumbLX;
        [FieldOffset(6)] public short sThumbLY;
        [FieldOffset(8)] public short sThumbRX;
        [FieldOffset(10)] public short sThumbRY;
    }

    // XInput button bitmasks → Chromium Gamepad API button indices
    private static readonly (ushort mask, int index)[] ButtonMap =
    [
        (0x1000, 0),  // A
        (0x2000, 1),  // B
        (0x4000, 2),  // X
        (0x8000, 3),  // Y
        (0x0100, 4),  // LB
        (0x0200, 5),  // RB
        (0x0020, 8),  // Back / View (−)
        (0x0010, 9),  // Start / Menu (+)
        (0x0040, 10), // Left thumb
        (0x0080, 11), // Right thumb
        (0x0001, 12), // D-Up
        (0x0002, 13), // D-Down
        (0x0004, 14), // D-Left
        (0x0008, 15), // D-Right
    ];

    public static object Poll()
    {
        const uint ERROR_SUCCESS = 0;
        const byte TRIGGER_THRESHOLD = 128;

        var allPressed = new HashSet<int>();
        var anyConnected = false;

        for (uint i = 0; i < 4; i++)
        {
            if (XInputGetState(i, out var state) != ERROR_SUCCESS) continue;
            anyConnected = true;
            var buttons = state.Gamepad.wButtons;
            foreach (var (mask, index) in ButtonMap)
            {
                if ((buttons & mask) != 0) allPressed.Add(index);
            }
            if (state.Gamepad.bLeftTrigger >= TRIGGER_THRESHOLD) allPressed.Add(6);
            if (state.Gamepad.bRightTrigger >= TRIGGER_THRESHOLD) allPressed.Add(7);
        }

        return new { connected = anyConnected, pressed = allPressed.OrderBy(x => x).ToArray() };
    }
}

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
            extended = Children(values["extended"]),
            raw = ToPlainObject(values)
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

    private static object? ToPlainObject(KeyValue value)
    {
        if (value.Children.Count == 0)
        {
            return Value(value);
        }

        var result = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
        if (!string.IsNullOrWhiteSpace(value.Value))
        {
            result["_value"] = value.Value;
        }

        foreach (var child in value.Children)
        {
            if (string.IsNullOrWhiteSpace(child.Name))
            {
                continue;
            }

            var mapped = ToPlainObject(child);
            if (!result.TryGetValue(child.Name, out var existing))
            {
                result[child.Name] = mapped;
                continue;
            }

            if (existing is List<object?> list)
            {
                list.Add(mapped);
            }
            else
            {
                result[child.Name] = new List<object?> { existing, mapped };
            }
        }

        return result;
    }

    public void Dispose()
    {
        callbackLoopCancellation.Cancel();
        steamClient.Disconnect();
        callbackLoopCancellation.Dispose();
    }
}
