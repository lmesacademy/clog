// Stands in for a service's own logger.ts that wraps console.
export function wrappedLog(message: string): void {
  console.log(`[wrapped] ${message}`);
}
