export type ArtifactsEventType = "cf.artifacts.repo.created" | "cf.artifacts.repo.deleted" | "cf.artifacts.repo.forked" | "cf.artifacts.repo.imported" | "cf.artifacts.repo.pushed" | "cf.artifacts.repo.cloned" | "cf.artifacts.repo.fetched" | "cf.artifacts.repo.token.created" | "cf.artifacts.repo.token.revoked";
export interface ArtifactsEvent {
    type: ArtifactsEventType;
    source: {
        type: "artifacts" | "artifacts.repo";
        namespace: string;
        repoName: string;
    };
    payload: Record<string, unknown>;
    metadata: {
        accountId: string;
        eventSubscriptionId: string;
        eventSchemaVersion: 1;
        eventTimestamp: string;
    };
}
export type EventListener = (event: ArtifactsEvent) => void | Promise<void>;
export declare class EventBus {
    readonly accountId: string;
    readonly history: ArtifactsEvent[];
    readonly maxHistory: number;
    private listeners;
    private now;
    constructor(accountId: string, now?: () => number, maxHistory?: number);
    subscribe(listener: EventListener): () => void;
    emit(type: ArtifactsEventType, namespace: string, repoName: string, payload: Record<string, unknown>): ArtifactsEvent;
}
/** POST each event as JSON to a URL, the local stand-in for a Queue consumer. */
export declare function webhookListener(url: string, fetchImpl?: typeof fetch): EventListener;
