declare module 'openclaw/plugin-sdk/core' {
  import type { TObject } from '@sinclair/typebox';
  import type { IncomingMessage, ServerResponse } from 'node:http';

  export interface PluginConfig {
    [key: string]: unknown;
  }

  export interface ToolResult {
    content: Array<{ type: 'text'; text: string }>;
  }

  export interface ToolDefinition<T = unknown> {
    name: string;
    description: string;
    parameters: TObject;
    execute: (toolCallId: string, params: T) => ToolResult | Promise<ToolResult>;
  }

  export interface ToolOptions {
    optional?: boolean;
  }

  export interface HttpRouteConfig {
    path: string;
    auth: 'plugin' | 'gateway' | 'none';
    match?: 'exact' | 'prefix';
    replaceExisting?: boolean;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;
  }

  export interface PluginApi {
    config: PluginConfig;
    registerTool: (definition: ToolDefinition, options?: ToolOptions) => void;
    registerHttpRoute: (config: HttpRouteConfig) => void;
  }

  export interface PluginEntry {
    id: string;
    name: string;
    register: (api: PluginApi) => void;
  }

  export function definePluginEntry(entry: PluginEntry): PluginEntry;
}
