type EventHandler = (payload: any) => void | Promise<void>;
declare class StudioEventBus {
    private emitter;
    private listeners;
    publish(channel: string, payload: any): void;
    subscribe(channel: string, handler: EventHandler): void;
    unsubscribe(channel: string, handler: EventHandler): void;
    once(channel: string, handler: EventHandler): void;
    unsubscribeAll(channel: string): void;
    private matchPattern;
    clear(): void;
}
export declare const eventBus: StudioEventBus;
export { StudioEventBus };
//# sourceMappingURL=event-bus.d.ts.map