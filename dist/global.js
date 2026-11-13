"use strict";
(() => {
  // src/preferences/validation.ts
  function validateBackendUrl(value) {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/i.test(trimmed)) {
      throw new Error("The library server URL must start with https:// or http://.");
    }
    return trimmed;
  }
  function normalizeTimeout(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(180, Math.max(5, numeric)) : 45;
  }

  // src/shared/encoding.ts
  var URI_PREFIX = "uri-v1:";
  function encodePreferenceJson(value) {
    return `${URI_PREFIX}${encodeURIComponent(JSON.stringify(value))}`;
  }
  function decodePreferenceJson(value, allowRaw = false) {
    if (typeof value !== "string" || value.length === 0) return null;
    let source;
    if (value.startsWith(URI_PREFIX)) {
      try {
        source = decodeURIComponent(value.slice(URI_PREFIX.length));
      } catch (_error) {
        return null;
      }
    } else if (allowRaw) {
      source = value;
    } else {
      return null;
    }
    try {
      return JSON.parse(source);
    } catch (_error) {
      return null;
    }
  }
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // src/llm/response.ts
  function withTimeout(promise, timeoutSeconds, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutSeconds * 1e3);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  // src/account/status.ts
  var ACCOUNT_STATUS_KEY = "accountStatus";
  var ACCOUNT_CHECK_COMMAND_KEY = "accountCheckCommand";
  var SIGNED_OUT_STATUS = {
    state: "signed-out",
    message: "Paste a plugin token from linegloss.com to connect.",
    userName: "",
    expiresAt: null,
    checkedAt: null
  };
  function serializeAccountStatus(status) {
    return encodePreferenceJson(status);
  }
  function looksLikePluginToken(value) {
    return /^lgp_[A-Za-z0-9_-]{43}$/.test(value.trim());
  }

  // src/account/runtime.ts
  var POLL_INTERVAL_MS = 1e3;
  var RECHECK_INTERVAL_MS = 30 * 6e4;
  var RETRY_INTERVAL_MS = 6e4;
  var AccountRuntime = class {
    constructor(preferences, http2, options = {}) {
      this.preferences = preferences;
      this.http = http2;
      this.running = false;
      this.lastToken = null;
      this.lastBackend = "";
      this.lastCommand = "";
      this.nextCheckAt = 0;
      var _a, _b;
      this.now = (_a = options.now) != null ? _a : (() => Date.now());
      this.schedule = (_b = options.schedule) != null ? _b : ((callback, delayMs) => setTimeout(callback, delayMs));
    }
    start() {
      void this.pollOnce().finally(() => this.scheduleNextPoll());
    }
    async pollOnce() {
      if (this.running) return;
      const token = readString(this.preferences.get("pluginToken"));
      const backend = readString(this.preferences.get("backendApiUrl"));
      const command = readString(this.preferences.get(ACCOUNT_CHECK_COMMAND_KEY));
      const changed = token !== this.lastToken || backend !== this.lastBackend;
      const requested = command.length > 0 && command !== this.lastCommand;
      this.lastToken = token;
      this.lastBackend = backend;
      if (requested) this.lastCommand = command;
      if (!token) {
        if (changed || requested) this.signOut();
        return;
      }
      if (!changed && !requested && this.now() < this.nextCheckAt) return;
      this.running = true;
      try {
        await this.verify(token, backend, changed || requested);
      } finally {
        this.running = false;
      }
    }
    async verify(token, backend, announce) {
      if (!looksLikePluginToken(token)) {
        this.clearIdentity();
        this.nextCheckAt = Number.MAX_SAFE_INTEGER;
        this.writeStatus({
          state: "invalid",
          message: "This doesn't look like a plugin token. Copy the whole token that starts with lgp_.",
          userName: "",
          expiresAt: null
        });
        return;
      }
      if (announce) {
        this.writeStatus({ state: "checking", message: "Checking your plugin token\u2026", userName: "", expiresAt: null });
      }
      let response;
      try {
        const backendApiUrl = validateBackendUrl(backend);
        const timeoutSeconds = normalizeTimeout(this.preferences.get("timeoutSeconds"));
        response = await withTimeout(
          this.http.get(
            `${backendApiUrl}/api/auth/me`,
            { headers: { Authorization: `Bearer ${token}` }, params: {}, data: {} },
            readString(this.preferences.get("socks5ProxyUrl")),
            timeoutSeconds
          ),
          timeoutSeconds,
          `no answer within ${timeoutSeconds} seconds`
        );
      } catch (error) {
        this.unreachable(error instanceof Error ? error.message : String(error));
        return;
      }
      const body = readBody(response);
      if (response.statusCode === 401) {
        this.clearIdentity();
        this.nextCheckAt = Number.MAX_SAFE_INTEGER;
        this.writeStatus({
          state: "invalid",
          message: "This token is invalid, expired, or revoked. Create a new one on linegloss.com.",
          userName: "",
          expiresAt: null
        });
        return;
      }
      const data = isRecord(body.data) ? body.data : null;
      const user = data && isRecord(data.user) ? data.user : null;
      const session = data && isRecord(data.session) ? data.session : null;
      const userId = user ? readString(user.id) : "";
      const userName = user ? readString(user.userName) : "";
      if (response.statusCode < 200 || response.statusCode >= 300 || !userId) {
        this.unreachable(`The library answered with an error (${response.statusCode}).`);
        return;
      }
      if (session && session.kind !== "plugin") {
        this.clearIdentity();
        this.nextCheckAt = Number.MAX_SAFE_INTEGER;
        this.writeStatus({
          state: "invalid",
          message: "That is a website session, not a plugin token. Create a plugin token in Settings on linegloss.com.",
          userName: "",
          expiresAt: null
        });
        return;
      }
      this.preferences.set("accountUserId", userId);
      this.preferences.set("accountUserName", userName);
      this.nextCheckAt = this.now() + RECHECK_INTERVAL_MS;
      this.writeStatus({
        state: "connected",
        message: `Connected as ${userName || "your account"}.`,
        userName,
        expiresAt: session && typeof session.expiresAt === "string" ? session.expiresAt : null
      });
    }
    unreachable(reason) {
      this.nextCheckAt = this.now() + RETRY_INTERVAL_MS;
      this.writeStatus({
        state: "unreachable",
        message: `Couldn't reach the library: ${reason.slice(0, 160)}`,
        userName: readString(this.preferences.get("accountUserName")),
        expiresAt: null
      });
    }
    signOut() {
      this.clearIdentity();
      this.writeStatus({ ...SIGNED_OUT_STATUS });
    }
    clearIdentity() {
      this.preferences.set("accountUserId", "");
      this.preferences.set("accountUserName", "");
    }
    writeStatus(status) {
      this.preferences.set(ACCOUNT_STATUS_KEY, serializeAccountStatus({ ...status, checkedAt: this.now() }));
      this.preferences.sync();
    }
    scheduleNextPoll() {
      this.schedule(() => {
        void this.pollOnce().finally(() => this.scheduleNextPoll());
      }, POLL_INTERVAL_MS);
    }
  };
  function readBody(response) {
    if (isRecord(response.data)) return response.data;
    try {
      const parsed = response.text ? JSON.parse(response.text) : {};
      return isRecord(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }
  function readString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  // src/host/pluginDataPath.ts
  function resolvePluginDataPath(utils) {
    const resolved = utils.resolvePath("@data/").trim().replace(/\/+$/, "");
    if (!resolved.startsWith("/")) {
      throw new Error("IINA did not return an absolute plugin data directory.");
    }
    return resolved;
  }

  // src/network/proxy.ts
  var SOCKS5_PROTOCOLS = /* @__PURE__ */ new Set(["socks5:", "socks5h:"]);
  function normalizeOptionalProxy(value) {
    return typeof value === "string" ? value.trim() : "";
  }
  function validateSocks5Proxy(value) {
    const proxyUrl = normalizeOptionalProxy(value);
    if (!proxyUrl) {
      return "";
    }
    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(proxyUrl);
    const protocol = schemeMatch ? `${schemeMatch[1].toLowerCase()}:` : "";
    if (!SOCKS5_PROTOCOLS.has(protocol)) {
      throw new Error("The proxy URL must start with socks5:// or socks5h://.");
    }
    const authority = (schemeMatch == null ? void 0 : schemeMatch[2]) || "";
    if (!authority || /[/?#\s]/.test(authority)) {
      throw new Error("The SOCKS5 proxy URL cannot include a path, query, or fragment.");
    }
    const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
    const portMatch = hostAndPort.startsWith("[") ? /^\[[^\]]+\]:(\d+)$/.exec(hostAndPort) : /^([^:]+):(\d+)$/.exec(hostAndPort);
    const port = portMatch ? Number(portMatch[portMatch.length - 1]) : 0;
    if (!portMatch || port < 1 || port > 65535) {
      throw new Error("The SOCKS5 proxy URL must include a hostname and valid port.");
    }
    return proxyUrl;
  }

  // src/network/curlConfig.ts
  var CURL_PATH = "/usr/bin/curl";
  async function executeCurlWithProtectedConfig(file, utils, purpose, lines) {
    const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const configPath = `@tmp/${purpose}-${suffix}.conf`;
    const configRealPath = utils.resolvePath(configPath);
    file.write(configPath, "");
    try {
      const permission = await utils.exec("/bin/chmod", ["600", configRealPath]);
      if (permission.status !== 0) {
        throw new Error("Could not protect the temporary network configuration.");
      }
      file.write(configPath, `${lines.join("\n")}
`);
      return await utils.exec(CURL_PATH, ["--config", configRealPath]);
    } finally {
      try {
        if (file.exists(configPath)) file.delete(configPath);
      } catch (_error) {
      }
    }
  }
  function quoteCurlConfig(value) {
    if (/[\r\n\u0000]/.test(value)) {
      throw new Error("Network settings contain an invalid control character.");
    }
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  // src/network/client.ts
  var STATUS_MARKER = "__IINA_HTTP_STATUS__:";
  var ProxyAwareHttpClient = class {
    constructor(http2, file, utils) {
      this.http = http2;
      this.file = file;
      this.utils = utils;
    }
    get(url, options, proxyUrl, timeoutSeconds) {
      return this.request("GET", url, options, proxyUrl, timeoutSeconds);
    }
    post(url, options, proxyUrl, timeoutSeconds) {
      return this.request("POST", url, options, proxyUrl, timeoutSeconds);
    }
    request(method, url, options, proxyUrl, timeoutSeconds) {
      const validatedProxy = validateSocks5Proxy(proxyUrl);
      if (!validatedProxy) {
        return method === "GET" ? this.http.get(url, options) : this.http.post(url, options);
      }
      return this.requestWithCurl(method, url, options, validatedProxy, timeoutSeconds);
    }
    async requestWithCurl(method, url, options, proxyUrl, timeoutSeconds) {
      if (options.params && Object.keys(options.params).length > 0) {
        url = appendQueryParams(url, options.params);
      }
      const lines = [
        "silent",
        "show-error",
        "location",
        `request = ${quoteCurlConfig(method)}`,
        `max-time = ${Math.max(1, Math.round(timeoutSeconds))}`,
        `proxy = ${quoteCurlConfig(proxyUrl)}`,
        `url = ${quoteCurlConfig(url)}`,
        ...Object.entries(options.headers || {}).map(([name, value]) => `header = ${quoteCurlConfig(`${name}: ${value}`)}`)
      ];
      if (method !== "GET" && options.data !== void 0) {
        lines.push(`data-binary = ${quoteCurlConfig(JSON.stringify(options.data))}`);
      }
      lines.push(`write-out = ${quoteCurlConfig(`\\n${STATUS_MARKER}%{http_code}`)}`);
      const result = await executeCurlWithProtectedConfig(this.file, this.utils, "http", lines);
      if (result.status !== 0) {
        throw new Error(`Proxied request transport failed (curl status ${result.status}).`);
      }
      return parseCurlResponse(result.stdout);
    }
  };
  function appendQueryParams(url, params) {
    const query = Object.entries(params).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
    if (!query) {
      return url;
    }
    return `${url}${url.includes("?") ? "&" : "?"}${query}`;
  }
  function parseCurlResponse(stdout) {
    const marker = `
${STATUS_MARKER}`;
    const markerIndex = stdout.lastIndexOf(marker);
    if (markerIndex < 0) {
      throw new Error("Proxied request returned an unreadable response.");
    }
    const text = stdout.slice(0, markerIndex);
    const rawStatus = stdout.slice(markerIndex + marker.length).trim();
    const statusCode = Number(rawStatus);
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
      throw new Error("Proxied request returned an invalid HTTP status.");
    }
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_error) {
        data = null;
      }
    }
    return {
      text,
      data,
      statusCode,
      reason: httpReason(statusCode)
    };
  }
  function httpReason(statusCode) {
    if (statusCode >= 200 && statusCode < 300) {
      return "OK";
    }
    if (statusCode === 400) return "Bad Request";
    if (statusCode === 401) return "Unauthorized";
    if (statusCode === 403) return "Forbidden";
    if (statusCode === 404) return "Not Found";
    if (statusCode === 409) return "Conflict";
    if (statusCode === 429) return "Too Many Requests";
    if (statusCode >= 500) return "Server Error";
    return "HTTP response";
  }

  // src/preferences/remote.ts
  var TEMPLATE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  var DEFAULT_PROMPT_TEMPLATE = {
    slug: "general-explanation",
    version: 1,
    title: "General explanation",
    description: "Explain meaning, tone, idioms, and a natural translation.",
    compatibilityVersion: 1,
    systemPrompt: [
      "You explain video subtitles for a viewer.",
      "Answer in {{preferredLanguage}}.",
      "Use a {{detailLevel}} level of detail.",
      "Explain meaning, idioms, cultural references, tone, and a natural translation when useful.",
      "Do not invent context beyond the provided subtitle and media metadata."
    ].join(" "),
    userInstruction: "Explain and translate the selected subtitle text for the viewer.",
    responseContract: "markdown-v1",
    placeholders: [{
      key: "detailLevel",
      type: "select",
      label: "Detail level",
      help: "Choose how much supporting detail the explanation should include.",
      defaultValue: "concise",
      required: true,
      options: [
        { value: "concise", label: "Concise" },
        { value: "balanced", label: "Balanced" },
        { value: "detailed", label: "Detailed" }
      ]
    }]
  };
  var DEFAULT_HOSTED_MODEL = { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B" };
  var DEFAULT_REMOTE_PREFERENCE_BUNDLE = {
    version: "bundled-default",
    catalogVersion: 1,
    preferences: {
      schemaVersion: 1,
      preferredLanguage: "English",
      temperature: 0.2,
      selectedTemplateSlug: DEFAULT_PROMPT_TEMPLATE.slug,
      clipAudioByDefault: false,
      hostedModel: DEFAULT_HOSTED_MODEL.id,
      hostedMaxOutputTokens: 1024
    },
    templateValues: { [DEFAULT_PROMPT_TEMPLATE.slug]: { detailLevel: "concise" } },
    templates: [DEFAULT_PROMPT_TEMPLATE],
    hostedModels: [DEFAULT_HOSTED_MODEL],
    updatedAt: null
  };
  function parseRemotePreferenceBundle(value) {
    return validateRemotePreferenceBundle(decodePreferenceJson(value, true));
  }
  function validateRemotePreferenceBundle(value) {
    var _a;
    if (!isRecord(value)) return null;
    const preferences = readPreferences(value.preferences);
    const legacyTemplateValues = isRecord(value.preferences) ? value.preferences.templateValues : void 0;
    const templateValues = readTemplateValues((_a = value.templateValues) != null ? _a : legacyTemplateValues);
    const templates = readTemplates(value.templates);
    const hostedModels = readHostedModels(value.hostedModels);
    if (typeof value.version !== "string" || value.version.length < 1 || value.version.length > 160 || typeof value.catalogVersion !== "number" || !Number.isInteger(value.catalogVersion) || value.catalogVersion < 1 || !preferences || !templateValues || !templates || !templates.some((template) => template.slug === preferences.selectedTemplateSlug) || !validateTemplateValues(templateValues, templates) || value.updatedAt !== null && typeof value.updatedAt !== "string") return null;
    return {
      version: value.version,
      catalogVersion: value.catalogVersion,
      preferences,
      templateValues,
      templates,
      hostedModels,
      updatedAt: value.updatedAt
    };
  }
  function serializeRemotePreferenceBundle(bundle) {
    return encodePreferenceJson(bundle);
  }
  function serializeRemoteSyncStatus(status) {
    return encodePreferenceJson(status);
  }
  function readPreferences(value) {
    if (!isRecord(value)) return null;
    if (value.schemaVersion !== 1 || typeof value.preferredLanguage !== "string" || !value.preferredLanguage.trim() || value.preferredLanguage.length > 80 || typeof value.temperature !== "number" || value.temperature < 0 || value.temperature > 2 || typeof value.selectedTemplateSlug !== "string" || !TEMPLATE_SLUG.test(value.selectedTemplateSlug)) return null;
    const defaults = DEFAULT_REMOTE_PREFERENCE_BUNDLE.preferences;
    const maxTokens = value.hostedMaxOutputTokens;
    return {
      schemaVersion: 1,
      preferredLanguage: value.preferredLanguage,
      temperature: value.temperature,
      selectedTemplateSlug: value.selectedTemplateSlug,
      clipAudioByDefault: typeof value.clipAudioByDefault === "boolean" ? value.clipAudioByDefault : false,
      // Bundles from a Worker before 0.7.0 have no hosted fields; the hosted endpoint applies its own defaults.
      hostedModel: typeof value.hostedModel === "string" && /^@cf\/[\w.-]+\/[\w.-]+$/.test(value.hostedModel) ? value.hostedModel : defaults.hostedModel,
      hostedMaxOutputTokens: typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens >= 256 && maxTokens <= 4096 ? maxTokens : defaults.hostedMaxOutputTokens
    };
  }
  function readHostedModels(value) {
    const models = [];
    if (Array.isArray(value)) {
      for (const candidate of value.slice(0, 20)) {
        if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.label !== "string") continue;
        if (!candidate.id || candidate.id.length > 160 || !candidate.label || models.some((model) => model.id === candidate.id)) continue;
        models.push({ id: candidate.id, label: candidate.label.slice(0, 80) });
      }
    }
    if (models.length === 0) models.push(DEFAULT_HOSTED_MODEL);
    return models;
  }
  function readTemplateValues(value) {
    if (!isRecord(value)) return null;
    const templateValues = {};
    for (const [slug, rawValues] of Object.entries(value)) {
      if (!TEMPLATE_SLUG.test(slug) || !isRecord(rawValues)) return null;
      const values = {};
      for (const [key, rawValue] of Object.entries(rawValues)) {
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || typeof rawValue !== "string" && typeof rawValue !== "boolean") return null;
        if (typeof rawValue === "string" && rawValue.length > 240) return null;
        values[key] = rawValue;
      }
      templateValues[slug] = values;
    }
    return templateValues;
  }
  function readTemplates(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 50) return null;
    const templates = [];
    const slugs = /* @__PURE__ */ new Set();
    for (const candidate of value) {
      if (!isRecord(candidate) || typeof candidate.slug !== "string" || !TEMPLATE_SLUG.test(candidate.slug) || slugs.has(candidate.slug)) return null;
      if (typeof candidate.version !== "number" || !Number.isInteger(candidate.version) || candidate.version < 1 || candidate.compatibilityVersion !== 1 || typeof candidate.title !== "string" || candidate.title.length > 120 || typeof candidate.description !== "string" || candidate.description.length > 500 || typeof candidate.systemPrompt !== "string" || candidate.systemPrompt.length > 2e4 || typeof candidate.userInstruction !== "string" || candidate.userInstruction.length > 1e4 || candidate.responseContract !== "markdown-v1" && candidate.responseContract !== "sections-v1" || !Array.isArray(candidate.placeholders) || candidate.placeholders.length > 20) return null;
      const placeholders = candidate.placeholders.map(readPlaceholder);
      if (placeholders.some((placeholder) => !placeholder)) return null;
      const placeholderKeys = new Set(placeholders.map((placeholder) => placeholder == null ? void 0 : placeholder.key));
      if (placeholderKeys.size !== placeholders.length) return null;
      slugs.add(candidate.slug);
      templates.push({
        slug: candidate.slug,
        version: candidate.version,
        title: candidate.title,
        description: candidate.description,
        compatibilityVersion: 1,
        systemPrompt: candidate.systemPrompt,
        userInstruction: candidate.userInstruction,
        responseContract: candidate.responseContract,
        placeholders
      });
    }
    return templates;
  }
  function readPlaceholder(value) {
    if (!isRecord(value) || typeof value.key !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(value.key)) return null;
    if (value.type !== "select" && value.type !== "boolean" && value.type !== "short-text") return null;
    if (typeof value.label !== "string" || typeof value.help !== "string" || typeof value.required !== "boolean") return null;
    if (typeof value.defaultValue !== "string" && typeof value.defaultValue !== "boolean") return null;
    if (value.type === "boolean" && typeof value.defaultValue !== "boolean") return null;
    if (value.type !== "boolean" && typeof value.defaultValue !== "string") return null;
    let options;
    if (value.options !== void 0) {
      if (!Array.isArray(value.options) || value.options.length > 50) return null;
      options = [];
      for (const option of value.options) {
        if (!isRecord(option) || typeof option.value !== "string" || !option.value || typeof option.label !== "string" || !option.label) return null;
        options.push({ value: option.value, label: option.label });
      }
    }
    if (options && new Set(options.map((option) => option.value)).size !== options.length) return null;
    if (value.type === "select" && (!options || options.length < 1 || !options.some((option) => option.value === value.defaultValue))) return null;
    let maxLength;
    if (value.maxLength !== void 0) {
      if (typeof value.maxLength !== "number" || !Number.isInteger(value.maxLength) || value.maxLength < 1 || value.maxLength > 240) return null;
      maxLength = value.maxLength;
    }
    if (value.type === "short-text") {
      const defaultValue = value.defaultValue;
      if (value.required && !defaultValue.trim() || defaultValue.length > (maxLength != null ? maxLength : 120)) return null;
    }
    return {
      key: value.key,
      type: value.type,
      label: value.label.slice(0, 120),
      help: value.help.slice(0, 500),
      defaultValue: value.defaultValue,
      required: value.required,
      maxLength,
      options
    };
  }
  function validateTemplateValues(templateValues, templates) {
    var _a, _b;
    const templatesBySlug = new Map(templates.map((template) => [template.slug, template]));
    for (const slug of Object.keys(templateValues)) {
      if (!templatesBySlug.has(slug)) return false;
    }
    for (const template of templates) {
      const values = templateValues[template.slug];
      if (!values) return false;
      const placeholdersByKey = new Map(template.placeholders.map((placeholder) => [placeholder.key, placeholder]));
      if (Object.keys(values).some((key) => !placeholdersByKey.has(key))) return false;
      for (const placeholder of template.placeholders) {
        const value = values[placeholder.key];
        if (placeholder.type === "boolean") {
          if (typeof value !== "boolean") return false;
          continue;
        }
        if (typeof value !== "string") return false;
        if (placeholder.required && !value.trim() || value.length > ((_a = placeholder.maxLength) != null ? _a : 240)) return false;
        if (placeholder.type === "select" && !((_b = placeholder.options) == null ? void 0 : _b.some((option) => option.value === value))) return false;
      }
    }
    return true;
  }

  // src/preferences/syncRuntime.ts
  var POLL_INTERVAL_MS2 = 1e3;
  var REFRESH_INTERVAL_MS = 5 * 6e4;
  var BUNDLE_KEY = "remotePreferenceBundle";
  var STATUS_KEY = "remotePreferenceSyncStatus";
  var COMMAND_KEY = "remotePreferenceSyncCommand";
  var PreferenceSyncRuntime = class {
    constructor(preferences, http2, options = {}) {
      this.preferences = preferences;
      this.http = http2;
      this.running = false;
      this.lastToken = "";
      this.lastCommand = "";
      this.nextRefreshAt = 0;
      var _a, _b;
      this.now = (_a = options.now) != null ? _a : (() => Date.now());
      this.schedule = (_b = options.schedule) != null ? _b : ((callback, delayMs) => setTimeout(callback, delayMs));
    }
    start() {
      void this.pollOnce().finally(() => this.scheduleNextPoll());
    }
    async pollOnce() {
      var _a;
      if (this.running) return;
      const token = readString2(this.preferences.get("pluginToken"));
      const command = readString2(this.preferences.get(COMMAND_KEY));
      const tokenChanged = token !== this.lastToken;
      const commandChanged = Boolean(command && command !== this.lastCommand);
      this.lastToken = token;
      if (commandChanged) this.lastCommand = command;
      if (!token) {
        if (tokenChanged || commandChanged) {
          this.writeStatus("stale", "Connect your library to sync. The last synced settings stay in use.");
        }
        return;
      }
      if (!tokenChanged && !commandChanged && this.now() < this.nextRefreshAt) return;
      this.running = true;
      this.writeStatus("syncing", "Syncing\u2026", null);
      try {
        const backendApiUrl = validateBackendUrl(readString2(this.preferences.get("backendApiUrl")));
        const proxyUrl = readString2(this.preferences.get("socks5ProxyUrl"));
        const timeoutSeconds = readTimeout(this.preferences.get("timeoutSeconds"));
        const cached = parseRemotePreferenceBundle(this.preferences.get(BUNDLE_KEY));
        const headers = { Authorization: `Bearer ${token}` };
        if (cached == null ? void 0 : cached.version) headers["If-None-Match"] = cached.version;
        const response = await withTimeout(
          this.http.get(`${backendApiUrl}/api/preferences`, { headers, params: {}, data: {} }, proxyUrl, timeoutSeconds),
          timeoutSeconds,
          `Linegloss didn't answer within ${timeoutSeconds} seconds.`
        );
        if (response.statusCode === 304) {
          this.writeStatus("synced", "Up to date.");
        } else if (response.statusCode >= 200 && response.statusCode < 300) {
          const body = parseBody(response);
          if (!body) throw new Error("Linegloss returned an unreadable response.");
          if (!("data" in body)) throw new Error("Linegloss returned an incomplete response.");
          const bundle = validateRemotePreferenceBundle(body.data);
          if (!bundle) throw new Error("These settings need a newer version of the plugin.");
          this.preferences.set(BUNDLE_KEY, serializeRemotePreferenceBundle(bundle));
          this.writeStatus("synced", "Up to date.");
        } else {
          const body = parseBody(response);
          throw new Error(((_a = body == null ? void 0 : body.error) == null ? void 0 : _a.message) || `Sync failed (${response.statusCode}).`);
        }
        this.nextRefreshAt = this.now() + REFRESH_INTERVAL_MS;
      } catch (error) {
        this.nextRefreshAt = this.now() + Math.min(6e4, REFRESH_INTERVAL_MS);
        this.writeStatus("error", error instanceof Error ? error.message : String(error));
      } finally {
        this.preferences.set(COMMAND_KEY, "");
        this.preferences.sync();
        this.running = false;
      }
    }
    scheduleNextPoll() {
      this.schedule(() => {
        void this.pollOnce().finally(() => this.scheduleNextPoll());
      }, POLL_INTERVAL_MS2);
    }
    writeStatus(state, message, checkedAt = this.now()) {
      this.preferences.set(STATUS_KEY, serializeRemoteSyncStatus({ state, message, checkedAt }));
      this.preferences.sync();
    }
  };
  function parseBody(response) {
    const parsedData = readApiBody(response.data);
    if (parsedData) return parsedData;
    try {
      return response.text ? readApiBody(JSON.parse(response.text)) : null;
    } catch (_error) {
      return null;
    }
  }
  function readApiBody(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value;
    if (!("data" in record) && !("error" in record)) return null;
    const error = record.error;
    return {
      ...Object.prototype.hasOwnProperty.call(record, "data") ? { data: record.data } : {},
      ...error && typeof error === "object" && !Array.isArray(error) ? { error: { message: typeof error.message === "string" ? error.message : void 0 } } : {}
    };
  }
  function readString2(value) {
    return typeof value === "string" ? value.trim() : "";
  }
  function readTimeout(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(180, Math.max(5, numeric)) : 45;
  }

  // src/network/binaryUpload.ts
  var STATUS_MARKER2 = "__IINA_AUDIO_STATUS__:";
  var BinaryUploadClient = class {
    constructor(file, utils) {
      this.file = file;
      this.utils = utils;
    }
    async put(request) {
      const lines = [
        "silent",
        "show-error",
        "location",
        'request = "PUT"',
        `max-time = ${Math.max(1, Math.round(request.timeoutSeconds))}`,
        `url = ${quoteCurlConfig(request.url)}`,
        `upload-file = ${quoteCurlConfig(this.utils.resolvePath(request.filePath))}`,
        ...Object.entries(request.headers).map(([name, value]) => `header = ${quoteCurlConfig(`${name}: ${value}`)}`),
        ...request.proxyUrl ? [`proxy = ${quoteCurlConfig(request.proxyUrl)}`] : ['noproxy = "*"'],
        `write-out = ${quoteCurlConfig(`\\n${STATUS_MARKER2}%{http_code}`)}`
      ];
      const result = await executeCurlWithProtectedConfig(this.file, this.utils, "cloud-audio", lines);
      if (result.status !== 0) {
        throw new Error(`Audio upload transport failed (curl status ${result.status}).`);
      }
      return parseCurlOutput(result.stdout);
    }
  };
  function parseCurlOutput(stdout) {
    const marker = `
${STATUS_MARKER2}`;
    const markerIndex = stdout.lastIndexOf(marker);
    if (markerIndex < 0) throw new Error("Audio upload returned an unreadable response.");
    const text = stdout.slice(0, markerIndex);
    const statusCode = Number(stdout.slice(markerIndex + marker.length).trim());
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
      throw new Error("Audio upload returned an invalid HTTP status.");
    }
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_error) {
        data = null;
      }
    }
    return { statusCode, text, data };
  }

  // src/sync/contracts.ts
  function parseCloudSaveManifest(value) {
    if (!isRecord2(value) || value.schemaVersion !== 1 || !isRecord2(value.explanation)) return null;
    if (!isSafeId(value.jobId) || typeof value.createdAt !== "string" || !isHttpUrl(value.backendApiUrl) || !isSafeId(value.accountUserId) || value.step !== "pending-explanation" && value.step !== "pending-audio" && value.step !== "failed" || typeof value.explanationId !== "string" || value.explanationId.length > 80 || !isNonNegativeInteger(value.attempts) || typeof value.nextAttemptAt !== "number" || !Number.isFinite(value.nextAttemptAt) || typeof value.lastError !== "string" || value.lastError.length > 500) return null;
    const explanation = value.explanation;
    if (!isBoundedString(explanation.subtitle, 1e4) || !isBoundedString(explanation.explanation, 5e4) || explanation.timestamp !== null && (typeof explanation.timestamp !== "number" || !Number.isFinite(explanation.timestamp) || explanation.timestamp < 0) || typeof explanation.mediaTitle !== "string" || explanation.mediaTitle.length > 512 || !isBoundedString(explanation.promptTemplateSlug, 80) || !isPositiveInteger(explanation.promptTemplateVersion) || !isBoundedString(explanation.responseContract, 80)) return null;
    const audio = readAudio(value.audio);
    if (value.audio !== null && !audio) return null;
    return {
      schemaVersion: 1,
      jobId: value.jobId,
      createdAt: value.createdAt,
      backendApiUrl: value.backendApiUrl.replace(/\/+$/, ""),
      accountUserId: value.accountUserId,
      step: value.step,
      explanationId: value.explanationId,
      attempts: value.attempts,
      nextAttemptAt: value.nextAttemptAt,
      lastError: value.lastError,
      explanation: {
        subtitle: explanation.subtitle,
        explanation: explanation.explanation,
        timestamp: explanation.timestamp,
        mediaTitle: explanation.mediaTitle,
        promptTemplateSlug: explanation.promptTemplateSlug,
        promptTemplateVersion: explanation.promptTemplateVersion,
        responseContract: explanation.responseContract
      },
      audio
    };
  }
  function serializeCloudSaveQueueStatus(status) {
    return encodePreferenceJson(status);
  }
  function parseCloudSaveQueueCommand(value) {
    const parsed = decodePreferenceJson(value);
    if (!isRecord2(parsed) || !isSafeId(parsed.id)) return null;
    if (parsed.type !== "retry" && parsed.type !== "discard-failed") return null;
    if (typeof parsed.issuedAt !== "number" || !Number.isFinite(parsed.issuedAt)) return null;
    return { id: parsed.id, type: parsed.type, issuedAt: parsed.issuedAt };
  }
  function readAudio(value) {
    if (value === null) return null;
    if (!isRecord2(value)) return null;
    if (value.fileName !== "audio.m4a" || value.contentType !== "audio/mp4" || !isPositiveInteger(value.byteSize) || value.byteSize > 1024 * 1024 || !isNonNegativeInteger(value.startMs) || !isPositiveInteger(value.endMs) || !isPositiveInteger(value.durationMs) || value.endMs <= value.startMs || value.durationMs !== value.endMs - value.startMs || value.durationMs > 3e4 || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) return null;
    return {
      fileName: "audio.m4a",
      contentType: "audio/mp4",
      byteSize: value.byteSize,
      startMs: value.startMs,
      endMs: value.endMs,
      durationMs: value.durationMs,
      sha256: value.sha256
    };
  }
  function isRecord2(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isSafeId(value) {
    return typeof value === "string" && value.length >= 8 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
  }
  function isBoundedString(value, maxLength) {
    return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
  }
  function isNonNegativeInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
  }
  function isPositiveInteger(value) {
    return isNonNegativeInteger(value) && value > 0;
  }
  function isHttpUrl(value) {
    return typeof value === "string" && value.length <= 2048 && /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
  }

  // src/audio/clip.ts
  var AUDIO_CLIP_MAX_BYTES = 1024 * 1024;

  // src/sync/outbox.ts
  var CLOUD_SAVE_OUTBOX_PATH = "@data/cloud-save-outbox";
  var QUEUE_BYTE_LIMIT = 50 * 1024 * 1024;
  var CLOUD_SAVE_WAKE_MESSAGE = "linegloss:cloud-save-wake";
  function readDirectory(file, path) {
    const raw = file.list(path, { includeSubDir: false });
    if (!Array.isArray(raw)) return [];
    const root = path.replace(/\/+$/, "");
    return raw.filter((entry) => typeof entry === "object" && entry !== null && typeof entry.filename === "string" && isSafeDirectoryChild(entry.filename) && typeof entry.isDir === "boolean").map((entry) => ({
      filename: entry.filename,
      path: `${root}/${entry.filename}`,
      isDir: entry.isDir
    }));
  }
  function isSafeDirectoryChild(filename) {
    return filename.length > 0 && filename !== "." && filename !== ".." && !/[\\/\u0000]/.test(filename);
  }

  // src/sync/runtime.ts
  var POLL_INTERVAL_MS3 = 2e3;
  var COMMAND_MAX_AGE_MS = 6e4;
  var STATUS_KEY2 = "cloudSaveQueueStatus";
  var COMMAND_KEY2 = "cloudSaveQueueCommand";
  var CloudSaveSyncRuntime = class {
    constructor(api, http2, binary = new BinaryUploadClient(api.file, api.utils), options = {}) {
      this.api = api;
      this.http = http2;
      this.binary = binary;
      this.running = false;
      this.lastStatusSignature = "";
      this.lastToken = "";
      var _a, _b;
      this.now = (_a = options.now) != null ? _a : (() => Date.now());
      this.schedule = (_b = options.schedule) != null ? _b : ((callback, delayMs) => setTimeout(callback, delayMs));
    }
    start() {
      try {
        this.api.global.onMessage(CLOUD_SAVE_WAKE_MESSAGE, () => void this.pollOnce());
      } catch (_error) {
      }
      void this.pollOnce().finally(() => this.scheduleNextPoll());
    }
    async pollOnce() {
      if (this.running) return;
      this.running = true;
      try {
        await this.ensureOutboxDirectory();
        await this.applyCommand();
        const token = readString3(this.api.preferences.get("pluginToken"));
        const tokenChanged = token !== this.lastToken;
        this.lastToken = token;
        let backendApiUrl = "";
        let proxyUrl = "";
        let timeoutSeconds = 45;
        const accountUserId = readString3(this.api.preferences.get("accountUserId"));
        if (token) {
          backendApiUrl = validateBackendUrl(readString3(this.api.preferences.get("backendApiUrl")));
          proxyUrl = readString3(this.api.preferences.get("socks5ProxyUrl"));
          timeoutSeconds = readTimeout2(this.api.preferences.get("timeoutSeconds"));
        }
        let jobs = this.readJobs();
        if (token && tokenChanged) {
          for (const job of jobs) {
            if (job.manifest && job.manifest.step !== "failed" && job.manifest.nextAttemptAt > this.now()) {
              job.manifest.nextAttemptAt = 0;
              job.manifest.lastError = "";
              await this.writeManifest(job.path, job.manifest);
            }
          }
          jobs = this.readJobs();
        }
        if (jobs.length === 0) {
          this.writeStatus({ state: "idle", pendingCount: 0, failedCount: 0, message: "Nothing is waiting to sync.", updatedAt: this.now() });
          return;
        }
        if (!token) {
          this.writeQueueSummary(jobs, "waiting", "Connect your library to sync saves waiting on this Mac.");
          return;
        }
        if (!accountUserId) {
          this.writeQueueSummary(jobs, "waiting", "Waiting for Linegloss to confirm your plugin token.");
          return;
        }
        const candidateJob = jobs.find(({ manifest }) => manifest !== null && manifest.step !== "failed" && manifest.nextAttemptAt <= this.now() && manifest.backendApiUrl === backendApiUrl && manifest.accountUserId === accountUserId);
        if (!(candidateJob == null ? void 0 : candidateJob.manifest)) {
          const failed = jobs.filter((job) => {
            var _a;
            return ((_a = job.manifest) == null ? void 0 : _a.step) === "failed" || !job.manifest;
          }).length;
          const mismatch = jobs.some(({ manifest }) => manifest && (manifest.backendApiUrl !== backendApiUrl || manifest.accountUserId !== accountUserId));
          this.writeQueueSummary(
            jobs,
            failed > 0 ? "error" : "waiting",
            mismatch ? "Some saves belong to another account or server and stay paused until it is connected again." : failed > 0 ? "Some saves need attention." : "Saves will retry shortly."
          );
          return;
        }
        const candidate = { path: candidateJob.path, manifest: candidateJob.manifest };
        this.writeQueueSummary(jobs, "syncing", "Syncing\u2026");
        try {
          await this.processJob(candidate, token, proxyUrl, timeoutSeconds);
        } catch (error) {
          await this.recordFailure(candidate, error);
        }
        const remaining = this.readJobs();
        this.writeQueueSummary(
          remaining,
          remaining.some((job) => {
            var _a;
            return ((_a = job.manifest) == null ? void 0 : _a.step) === "failed" || !job.manifest;
          }) ? "error" : "waiting",
          remaining.length ? "Saves are waiting to sync." : "Everything is in your library."
        );
      } catch (error) {
        const jobs = this.readJobs();
        this.writeQueueSummary(jobs, "error", errorMessage(error));
      } finally {
        this.running = false;
      }
    }
    scheduleNextPoll() {
      this.schedule(() => void this.pollOnce().finally(() => this.scheduleNextPoll()), POLL_INTERVAL_MS3);
    }
    async processJob(job, token, proxyUrl, timeoutSeconds) {
      var _a, _b, _c;
      const manifest = job.manifest;
      if (manifest.step === "pending-explanation") {
        const response = await this.http.post(
          `${manifest.backendApiUrl}/api/explanations`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Idempotency-Key": manifest.jobId
            },
            params: {},
            data: manifest.explanation
          },
          proxyUrl,
          timeoutSeconds
        );
        const body = parseApiBody(response);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new SyncHttpError(response.statusCode, ((_a = body.error) == null ? void 0 : _a.message) || `Explanation sync failed (${response.statusCode}).`);
        }
        const explanationId = (_c = (_b = body.data) == null ? void 0 : _b.item) == null ? void 0 : _c.id;
        if (!explanationId) throw new Error("Linegloss returned an unexpected response.");
        manifest.explanationId = explanationId;
        manifest.attempts = 0;
        manifest.nextAttemptAt = 0;
        manifest.lastError = "";
        if (!manifest.audio) {
          this.api.file.trash(job.path);
          return;
        }
        manifest.step = "pending-audio";
        await this.writeManifest(job.path, manifest);
      }
      if (manifest.step === "pending-audio" && manifest.audio) {
        const audio = manifest.audio;
        const response = await this.binary.put({
          url: `${manifest.backendApiUrl}/api/explanations/${encodeURIComponent(manifest.explanationId)}/audio`,
          filePath: `${job.path}/${audio.fileName}`,
          proxyUrl,
          timeoutSeconds,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": audio.contentType,
            "Content-Length": String(audio.byteSize),
            "X-Clip-Start-Ms": String(audio.startMs),
            "X-Clip-End-Ms": String(audio.endMs),
            "X-Clip-Duration-Ms": String(audio.durationMs),
            "X-Content-SHA256": audio.sha256
          }
        });
        const body = readBodyRecord(response.data, response.text);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new SyncHttpError(response.statusCode, readApiErrorMessage(body) || `Audio sync failed (${response.statusCode}).`);
        }
        this.api.file.trash(job.path);
      }
    }
    async recordFailure(job, error) {
      const manifest = job.manifest;
      const permanent = error instanceof SyncHttpError && [400, 409, 413, 415, 422].includes(error.statusCode);
      manifest.attempts += 1;
      manifest.lastError = errorMessage(error).slice(0, 500);
      if (error instanceof SyncHttpError && error.statusCode === 401) {
        manifest.nextAttemptAt = Number.MAX_SAFE_INTEGER;
      } else if (permanent) {
        manifest.step = "failed";
        manifest.nextAttemptAt = 0;
      } else {
        const baseDelay = Math.min(60 * 6e4, 5e3 * 2 ** Math.min(manifest.attempts - 1, 9));
        manifest.nextAttemptAt = this.now() + baseDelay + Math.floor(Math.random() * Math.min(5e3, baseDelay / 4));
      }
      await this.writeManifest(job.path, manifest);
    }
    async applyCommand() {
      const rawCommand = this.api.preferences.get(COMMAND_KEY2);
      if (typeof rawCommand !== "string" || rawCommand.length === 0) return;
      const command = parseCloudSaveQueueCommand(rawCommand);
      this.api.preferences.set(COMMAND_KEY2, "");
      this.api.preferences.sync();
      if (!command || this.now() - command.issuedAt > COMMAND_MAX_AGE_MS) return;
      const jobs = this.readJobs();
      if (command.type === "discard-failed") {
        for (const job of jobs) {
          if (!job.manifest || job.manifest.step === "failed") this.api.file.trash(job.path);
        }
        return;
      }
      for (const job of jobs) {
        const manifest = job.manifest;
        if (!manifest) continue;
        if (manifest.step === "failed") {
          manifest.step = manifest.explanationId && manifest.audio ? "pending-audio" : "pending-explanation";
        }
        manifest.nextAttemptAt = 0;
        manifest.lastError = "";
        await this.writeManifest(job.path, manifest);
      }
    }
    readJobs() {
      if (!this.api.file.exists(CLOUD_SAVE_OUTBOX_PATH)) return [];
      return readDirectory(this.api.file, CLOUD_SAVE_OUTBOX_PATH).filter((entry) => entry.isDir && !entry.filename.startsWith(".staging-")).map((entry) => {
        try {
          const raw = this.api.file.read(`${entry.path}/manifest.json`, {});
          const value = typeof raw === "string" ? JSON.parse(raw) : null;
          return { path: entry.path, manifest: parseCloudSaveManifest(value) };
        } catch (_error) {
          return { path: entry.path, manifest: null };
        }
      });
    }
    async writeManifest(path, manifest) {
      const temporaryPath = `${path}/manifest.next.json`;
      const manifestPath = `${path}/manifest.json`;
      this.api.file.write(temporaryPath, `${JSON.stringify(manifest, null, 2)}
`);
      const result = await this.api.utils.exec("/bin/mv", [
        this.api.utils.resolvePath(temporaryPath),
        this.api.utils.resolvePath(manifestPath)
      ]);
      if (result.status !== 0) throw new Error("Linegloss couldn't update a waiting save on this Mac.");
    }
    async ensureOutboxDirectory() {
      if (this.api.file.exists(CLOUD_SAVE_OUTBOX_PATH)) return;
      const result = await this.api.utils.exec("/bin/mkdir", ["-p", this.api.utils.resolvePath(CLOUD_SAVE_OUTBOX_PATH)]);
      if (result.status !== 0) throw new Error("Linegloss couldn't open its save folder on this Mac.");
    }
    writeQueueSummary(jobs, state, message) {
      var _a, _b;
      const failedCount = jobs.filter((job) => !job.manifest || job.manifest.step === "failed").length;
      const invalidCount = jobs.filter((job) => !job.manifest).length;
      const firstFailure = (_b = (_a = jobs.find((job) => {
        var _a2;
        return ((_a2 = job.manifest) == null ? void 0 : _a2.step) === "failed" && job.manifest.lastError;
      })) == null ? void 0 : _a.manifest) == null ? void 0 : _b.lastError;
      const safeMessage = state === "error" ? invalidCount > 0 ? `${invalidCount} waiting ${invalidCount === 1 ? "save couldn't" : "saves couldn't"} be read. The files were kept.` : firstFailure ? `${failedCount} ${failedCount === 1 ? "save needs" : "saves need"} attention: ${firstFailure}` : message : message;
      this.writeStatus({
        state: jobs.length === 0 ? "idle" : state,
        pendingCount: jobs.length - failedCount,
        failedCount,
        message: safeMessage,
        updatedAt: this.now()
      });
    }
    writeStatus(status) {
      const signature = `${status.state}|${status.pendingCount}|${status.failedCount}|${status.message}`;
      if (signature === this.lastStatusSignature) return;
      this.lastStatusSignature = signature;
      this.api.preferences.set(STATUS_KEY2, serializeCloudSaveQueueStatus(status));
      this.api.preferences.sync();
    }
  };
  var SyncHttpError = class extends Error {
    constructor(statusCode, message) {
      super(message);
      this.statusCode = statusCode;
    }
  };
  function parseApiBody(response) {
    const body = readBodyRecord(response.data, response.text);
    const data = isRecord3(body.data) ? body.data : null;
    const item = data && isRecord3(data.item) ? data.item : null;
    const error = isRecord3(body.error) ? body.error : null;
    return {
      ...item ? { data: { item: { id: readString3(item.id) || void 0 } } } : {},
      ...error ? { error: { message: readString3(error.message) || void 0 } } : {}
    };
  }
  function readBodyRecord(data, text) {
    if (isRecord3(data)) return data;
    try {
      const parsed = text ? JSON.parse(text) : {};
      return isRecord3(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }
  function readApiErrorMessage(body) {
    return isRecord3(body.error) ? readString3(body.error.message) : "";
  }
  function isRecord3(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function readString3(value) {
    return typeof value === "string" ? value.trim() : "";
  }
  function readTimeout2(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(180, Math.max(5, numeric)) : 45;
  }
  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // src/global.ts
  var http = new ProxyAwareHttpClient(iina.http, iina.file, iina.utils);
  try {
    iina.preferences.set("pluginDataPath", resolvePluginDataPath(iina.utils));
    iina.preferences.sync();
  } catch (error) {
    iina.console.log(`Linegloss: could not resolve its data folder: ${error instanceof Error ? error.message : String(error)}`);
  }
  new AccountRuntime(iina.preferences, http).start();
  new PreferenceSyncRuntime(iina.preferences, http).start();
  new CloudSaveSyncRuntime(iina, http).start();
})();
