import { NotificationsEnableEvent } from "./GithubWebhooks";
import { Octokit } from "@octokit/rest";
import { createTokenAuth } from "@octokit/auth-token";
import { LogWrapper } from "./LogWrapper";
import { MessageQueue } from "./MessageQueue/MessageQueue";

interface UserStream {
    octoKit: Octokit,
    userId: string,
    roomId: string,
    lastReadTs: number,
}

export interface UserNotificationsEvent {
    roomId: string,
    lastReadTs: number,
    events: UserNotification[],
}

export interface UserNotification {
    id: string;
    reason: "assign"|"author"|"comment"|"invitation"|"manual"|"mention"|"review_required"|"security_alert"|"state_change"|"subscribed"|"team_mention";
    unread: boolean;
    updated_at: number;
    last_read_at: number;
    url: string;
    subject: {
        title: string;
        url: string;
        latest_comment_url: string|null;
        type: "PullRequest"|"Issue";
        url_data: any;
        latest_comment_url_data: any;
    };
    repository: Octokit.ActivityGetThreadResponseRepository;
}


const MIN_INTERVAL_MS = 45000;

const log = new LogWrapper("UserNotificationWatcher");

export class UserNotificationWatcher {
    private userStreams: Map<string, UserStream> = new Map();
    private userQueue: string[] = [];
    private shouldListen: boolean = false;

    constructor(private queue: MessageQueue) {

    }

    public start() {
        this.shouldListen = true;
        this.fetchUserNotifications().catch((ex) => {
            log.error("CRITICAL ERROR when fethcing user notifications:", ex);
        })
    }

    public async fetchUserNotifications() {
        let userId;
        while (this.shouldListen) {
            userId = this.userQueue.pop();
            if (!userId) {
                log.info(`No users queued for notifications, waiting for 5s`);
                await new Promise((res) => setTimeout(res, 5000));
                continue;
            }
            const stream = this.userStreams.get(userId);
            if (!stream) {
                log.warn("User is in the userQueue but has no stream, dropping from queue");
                continue;
            }
            const interval = MIN_INTERVAL_MS - (Date.now() - stream.lastReadTs);
            if (interval > 0) {
                log.info(`We read this users notifications ${MIN_INTERVAL_MS - interval}ms ago, waiting ${interval}ms`);
                await new Promise((res) => setTimeout(res, interval));
            }
            log.info(`Getting notifications for ${userId} ${stream.lastReadTs}`);
            try {
                const since = stream.lastReadTs !== 0 ? `&since=${new Date(stream.lastReadTs).toISOString()}`: "";
                const response = await stream.octoKit.request(`/notifications?participating=true${since}`);
                stream.lastReadTs = Date.now();
                const events: UserNotification[] = [];
                for (const rawEvent of response.data as UserNotification[]) {
                    try {
                        await (async () => {
                            if (rawEvent.subject.url) {
                                const res = await stream.octoKit.request(rawEvent.subject.url);
                                rawEvent.subject.url_data = res.data;
                            }
                            if (rawEvent.subject.latest_comment_url) {
                                const res = await stream.octoKit.request(rawEvent.subject.latest_comment_url);
                                rawEvent.subject.latest_comment_url_data = res.data;
                            }
                            events.push(rawEvent);
                        })();
                    } catch (ex) {
                        log.warn(`Failed to pre-process ${rawEvent.id}: ${ex}`);
                        // If it fails, we can just push the raw thing.
                        events.push(rawEvent);
                    }
                }
                this.queue.push<UserNotificationsEvent>({
                    eventName: "notifications.user.events",
                    data: {
                        roomId: stream.roomId,
                        events,
                        lastReadTs: stream.lastReadTs,
                    },
                    sender: "GithubWebhooks",
                });
            } catch (ex) {
                log.error("An error occured getting notifications:", ex);
            }
            this.userQueue.unshift(userId);
        }
    }

    public removeUser(userId: string) {
        this.userStreams.delete(userId);
        log.info(`Removed ${userId} to notif queue`);
    }

    public addUser(data: NotificationsEnableEvent) {
        const clientKit = new Octokit({
            authStrategy: createTokenAuth,
            auth: data.token,
            userAgent: "matrix-github v0.0.1",
        });

        const existing = this.userStreams.has(data.user_id);

        this.userStreams.set(data.user_id, {
            octoKit: clientKit,
            userId: data.user_id,
            roomId: data.room_id,
            lastReadTs: data.since,
        });
        if (!existing) {
            log.info(`Inserted ${data.user_id} into the notif queue`);
            this.userQueue.push(data.user_id);
        } else {
            log.info(`Reinserted ${data.user_id} into the notif queue`);
        }
    }
}
