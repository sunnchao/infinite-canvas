import { afterAll, expect, test } from "bun:test";

// Config and i18n use browser storage during module initialization; zustand persist reads window.localStorage.
const values = new Map<string, string>();
const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
};
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

const { defaultConfig, encodeChannelModel, upsertChannelCredentials, useConfigStore } = await import("../src/stores/use-config-store");

test("importing credentials returns the channel so its models can be fetched", () => {
    const result = upsertChannelCredentials({ ...defaultConfig, channels: [] }, { baseUrl: "https://api.example.com/v1", apiKey: "test-key" });
    expect(result.status).toBe("created");
    expect(result.channel?.baseUrl).toBe("https://api.example.com/v1");
});

test("re-importing the same provider clears its cached models and keeps the channel", () => {
    const existing = {
        id: "imported",
        name: "My provider",
        baseUrl: "https://api.example.com/v1",
        apiKey: "old-key",
        apiFormat: "openai" as const,
        models: [{ name: "stale-model", capability: "image" as const }],
    };
    const config = { ...defaultConfig, channels: [existing], models: [encodeChannelModel("imported", "stale-model")] };

    const result = upsertChannelCredentials(config, { baseUrl: "https://api.example.com/", apiKey: "new-key" });

    expect(result.status).toBe("updated");
    expect(result.channel?.id).toBe("imported");
    expect(result.channel?.name).toBe("My provider");
    expect(result.channel?.apiKey).toBe("new-key");
    expect(result.channel?.models).toEqual([]);
    expect(result.config.channels).toHaveLength(1);
    expect(result.config.models).toEqual([]);
});

test("fetched models merge into the imported channel without losing configured ones", () => {
    const channel = {
        id: "imported",
        name: "Imported",
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        apiFormat: "openai" as const,
        models: [{ name: "old-model", capability: "video" as const, script: "custom-script" }],
    };
    useConfigStore.setState({ config: { ...defaultConfig, channels: [channel], models: [] } });

    useConfigStore.getState().mergeChannelModels("imported", ["old-model", "new-image-model"]);

    const config = useConfigStore.getState().config;
    expect(config.channels[0].models).toEqual([
        { name: "old-model", capability: "video", script: "custom-script" },
        { name: "new-image-model", capability: "image", script: undefined },
    ]);
    expect(config.models).toEqual([encodeChannelModel("imported", "old-model"), encodeChannelModel("imported", "new-image-model")]);
});
