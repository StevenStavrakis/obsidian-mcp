import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

// Basic rate limiting for API protection
export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private maxRequests: number;
  private timeWindow: number;

  constructor(maxRequests: number = 1000, timeWindow: number = 60000) {
    // 1000 requests per minute for local usage
    this.maxRequests = maxRequests;
    this.timeWindow = timeWindow;
  }

  checkLimit(clientId: string): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(clientId) || [];

    // Remove old timestamps
    const validTimestamps = timestamps.filter(
      (time) => now - time < this.timeWindow
    );

    if (validTimestamps.length >= this.maxRequests) {
      return false;
    }

    validTimestamps.push(now);
    this.requests.set(clientId, validTimestamps);
    return true;
  }
}

// Message size validation to prevent memory issues
const MAX_MESSAGE_SIZE = 5 * 1024 * 1024; // 5MB for local usage

export function validateMessageSize(message: any): void {
  const size = new TextEncoder().encode(JSON.stringify(message)).length;
  if (size > MAX_MESSAGE_SIZE) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Message size exceeds limit of ${MAX_MESSAGE_SIZE} bytes`
    );
  }
}

// Connection activity tracking (monitoring only, no self-destruct)
export class ConnectionMonitor {
  private lastActivity: number = Date.now();

  updateActivity() {
    this.lastActivity = Date.now();
  }

  getLastActivity(): number {
    return this.lastActivity;
  }

  start(_onTimeout: () => void) {
    // No-op: MCP server lifecycle is managed by the client via the
    // transport layer. The server must not close itself on a timer
    // because the client has no way to detect a silently-closed
    // transport vs a hung server, and will wait forever.
    //
    // Previous versions (<=1.0.6) called server.close() after 60s of
    // inactivity measured only by tool calls (not protocol messages
    // like initialize/initialized). This caused the server to kill
    // its own stdio transport while the client still held a reference
    // to the process, making every subsequent tool call hang.
  }

  stop() {
    // No timers to clean up
  }
}
