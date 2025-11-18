/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Qwen Code CLI 应用的主要入口文件
 * 负责应用的初始化、配置加载、沙箱管理、UI渲染和命令处理
 */

import React from 'react';
import { render } from 'ink';
import { AppContainer } from './ui/AppContainer.js';
import { loadCliConfig, parseArguments } from './config/config.js';
import * as cliConfig from './config/config.js';
import { readStdin } from './utils/readStdin.js';
import { basename } from 'node:path';
import v8 from 'node:v8';
import os from 'node:os';
import dns from 'node:dns';
import { randomUUID } from 'node:crypto';
import { start_sandbox } from './utils/sandbox.js';
import type { DnsResolutionOrder, LoadedSettings } from './config/settings.js';
import { loadSettings, migrateDeprecatedSettings } from './config/settings.js';
import { themeManager } from './ui/themes/theme-manager.js';
import { getStartupWarnings } from './utils/startupWarnings.js';
import { getUserStartupWarnings } from './utils/userStartupWarnings.js';
import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';
import { runNonInteractive } from './nonInteractiveCli.js';
import { ExtensionStorage, loadExtensions } from './config/extension.js';
import {
  cleanupCheckpoints,
  registerCleanup,
  runExitCleanup,
} from './utils/cleanup.js';
import { getCliVersion } from './utils/version.js';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  AuthType,
  getOauthClient,
  logUserPrompt,
} from '@qwen-code/qwen-code-core';
import {
  initializeApp,
  type InitializationResult,
} from './core/initializer.js';
import { validateAuthMethod } from './config/auth.js';
import { setMaxSizedBoxDebugging } from './ui/components/shared/MaxSizedBox.js';
import { SettingsContext } from './ui/contexts/SettingsContext.js';
import { detectAndEnableKittyProtocol } from './ui/utils/kittyProtocolDetector.js';
import { checkForUpdates } from './ui/utils/updateCheck.js';
import { handleAutoUpdate } from './utils/handleAutoUpdate.js';
import { computeWindowTitle } from './utils/windowTitle.js';
import { SessionStatsProvider } from './ui/contexts/SessionContext.js';
import { VimModeProvider } from './ui/contexts/VimModeContext.js';
import { KeypressProvider } from './ui/contexts/KeypressContext.js';
import { appEvents, AppEvent } from './utils/events.js';
import { useKittyKeyboardProtocol } from './ui/hooks/useKittyKeyboardProtocol.js';
import {
  relaunchOnExitCode,
  relaunchAppInChildProcess,
} from './utils/relaunch.js';
import { validateNonInteractiveAuth } from './validateNonInterActiveAuth.js';

/**
 * 验证 DNS 解析顺序设置
 * @param order DNS解析顺序设置值
 * @returns 验证后的 DNS 解析顺序
 */
export function validateDnsResolutionOrder(
  order: string | undefined,
): DnsResolutionOrder {
  const defaultValue: DnsResolutionOrder = 'ipv4first';
  if (order === undefined) {
    return defaultValue;
  }
  if (order === 'ipv4first' || order === 'verbatim') {
    return order;
  }
  // We don't want to throw here, just warn and use the default.
  console.warn(
    `Invalid value for dnsResolutionOrder in settings: "${order}". Using default "${defaultValue}".`,
  );
  return defaultValue;
}

/**
 * 计算 Node.js 进程的内存参数
 * 自动配置最大旧空间大小为系统总内存的 50%
 * @param isDebugMode 是否为调试模式
 * @returns 内存配置参数数组
 */
function getNodeMemoryArgs(isDebugMode: boolean): string[] {
  const totalMemoryMB = os.totalmem() / (1024 * 1024);
  const heapStats = v8.getHeapStatistics();
  const currentMaxOldSpaceSizeMb = Math.floor(
    heapStats.heap_size_limit / 1024 / 1024,
  );

  // Set target to 50% of total memory
  const targetMaxOldSpaceSizeInMB = Math.floor(totalMemoryMB * 0.5);
  if (isDebugMode) {
    console.debug(
      `Current heap size ${currentMaxOldSpaceSizeMb.toFixed(2)} MB`,
    );
  }

  if (process.env['GEMINI_CLI_NO_RELAUNCH']) {
    return [];
  }

  if (targetMaxOldSpaceSizeInMB > currentMaxOldSpaceSizeMb) {
    if (isDebugMode) {
      console.debug(
        `Need to relaunch with more memory: ${targetMaxOldSpaceSizeInMB.toFixed(2)} MB`,
      );
    }
    return [`--max-old-space-size=${targetMaxOldSpaceSizeInMB}`];
  }

  return [];
}

import { runZedIntegration } from './zed-integration/zedIntegration.js';
import { loadSandboxConfig } from './config/sandboxConfig.js';
import { ExtensionEnablementManager } from './config/extensions/extensionEnablement.js';

/**
 * 设置未处理的 Promise 拒绝处理器
 * 用于捕获未处理的异步错误并记录日志
 */
export function setupUnhandledRejectionHandler() {
  let unhandledRejectionOccurred = false;
  process.on('unhandledRejection', (reason, _promise) => {
    const errorMessage = `=========================================
This is an unexpected error. Please file a bug report using the /bug tool.
CRITICAL: Unhandled Promise Rejection!
=========================================
Reason: ${reason}${
      reason instanceof Error && reason.stack
        ? `
Stack trace:
${reason.stack}`
        : ''
    }`;
    appEvents.emit(AppEvent.LogError, errorMessage);
    if (!unhandledRejectionOccurred) {
      unhandledRejectionOccurred = true;
      appEvents.emit(AppEvent.OpenDebugConsole);
    }
  });
}

/**
 * 启动交互式 UI 模式
 * 设置各种 React Context Provider 并渲染主应用容器
 * @param config 应用配置
 * @param settings 用户设置
 * @param startupWarnings 启动警告消息
 * @param workspaceRoot 工作空间根目录
 * @param initializationResult 初始化结果
 */
export async function startInteractiveUI(
  config: Config,
  settings: LoadedSettings,
  startupWarnings: string[],
  workspaceRoot: string = process.cwd(),
  initializationResult: InitializationResult,
) {
  const version = await getCliVersion();
  setWindowTitle(basename(workspaceRoot), settings);

  // Create wrapper component to use hooks inside render
  const AppWrapper = () => {
    const kittyProtocolStatus = useKittyKeyboardProtocol();
    const nodeMajorVersion = parseInt(process.versions.node.split('.')[0], 10);
    return (
      <SettingsContext.Provider value={settings}>
        <KeypressProvider
          kittyProtocolEnabled={kittyProtocolStatus.enabled}
          config={config}
          debugKeystrokeLogging={settings.merged.general?.debugKeystrokeLogging}
          pasteWorkaround={
            process.platform === 'win32' || nodeMajorVersion < 20
          }
        >
          <SessionStatsProvider>
            <VimModeProvider settings={settings}>
              <AppContainer
                config={config}
                settings={settings}
                startupWarnings={startupWarnings}
                version={version}
                initializationResult={initializationResult}
              />
            </VimModeProvider>
          </SessionStatsProvider>
        </KeypressProvider>
      </SettingsContext.Provider>
    );
  };

  const instance = render(
    process.env['DEBUG'] ? (
      <React.StrictMode>
        <AppWrapper />
      </React.StrictMode>
    ) : (
      <AppWrapper />
    ),
    {
      exitOnCtrlC: false,
      isScreenReaderEnabled: config.getScreenReader(),
    },
  );

  // 检查更新并在后台处理自动更新
  checkForUpdates()
    .then((info) => {
      handleAutoUpdate(info, settings, config.getProjectRoot());
    })
    .catch((err) => {
      // Silently ignore update check errors.
      if (config.getDebugMode()) {
        console.error('Update check failed:', err);
      }
    });

  registerCleanup(() => instance.unmount());
}

/**
 * Qwen Code CLI 应用的主启动函数
 * 负责整个应用的初始化流程，包括：
 * 1. 设置加载和参数解析
 * 2. 沙箱配置和认证处理
 * 3. 扩展加载
 * 4. UI 模式或非交互式模式选择
 */
export async function main() {
  setupUnhandledRejectionHandler();  // 设置未处理拒绝处理器
  const settings = loadSettings();   // 加载用户设置
  migrateDeprecatedSettings(settings); // 迁移废弃的设置
  await cleanupCheckpoints();       // 清理检查点
  const sessionId = randomUUID();   // 生成会话ID

  // 解析命令行参数
  const argv = await parseArguments(settings.merged);

  // Check for invalid input combinations early to prevent crashes
  // 验证输入参数组合的有效性
  if (argv.promptInteractive && !process.stdin.isTTY) {
    console.error(
      'Error: The --prompt-interactive flag cannot be used when input is piped from stdin.',
    );
    process.exit(1);
  }

  const isDebugMode = cliConfig.isDebugMode(argv);
  // 设置控制台补丁
  const consolePatcher = new ConsolePatcher({
    stderr: true,
    debugMode: isDebugMode,
  });
  consolePatcher.patch();
  registerCleanup(consolePatcher.cleanup);

  // 设置 DNS 解析顺序
  dns.setDefaultResultOrder(
    validateDnsResolutionOrder(settings.merged.advanced?.dnsResolutionOrder),
  );

  // 从设置中加载自定义主题
  // Load custom themes from settings
  themeManager.loadCustomThemes(settings.merged.ui?.customThemes);

  if (settings.merged.ui?.theme) {
    if (!themeManager.setActiveTheme(settings.merged.ui?.theme)) {
      // If the theme is not found during initial load, log a warning and continue.
      // The useThemeCommand hook in AppContainer.tsx will handle opening the dialog.
      console.warn(`Warning: Theme "${settings.merged.ui?.theme}" not found.`);
    }
  }

  // 沙箱处理逻辑
  // 进入沙箱（如果当前不在沙箱中且启用了沙箱）
  // hop into sandbox if we are outside and sandboxing is enabled
  if (!process.env['SANDBOX']) {
    const memoryArgs = settings.merged.advanced?.autoConfigureMemory
      ? getNodeMemoryArgs(isDebugMode)
      : [];
    const sandboxConfig = await loadSandboxConfig(settings.merged, argv);
    // We intentially omit the list of extensions here because extensions
    // should not impact auth or setting up the sandbox.
    // TODO(jacobr): refactor loadCliConfig so there is a minimal version
    // that only initializes enough config to enable refreshAuth or find
    // another way to decouple refreshAuth from requiring a config.

    if (sandboxConfig) {
      const partialConfig = await loadCliConfig(
        settings.merged,
        [],
        new ExtensionEnablementManager(ExtensionStorage.getUserExtensionsDir()),
        sessionId,
        argv,
      );

      if (
        settings.merged.security?.auth?.selectedType &&
        !settings.merged.security?.auth?.useExternal
      ) {
        // 验证认证，因为沙箱会干扰 OAuth2 网页重定向
        // Validate authentication here because the sandbox will interfere with the Oauth2 web redirect.
        try {
          const err = validateAuthMethod(
            settings.merged.security.auth.selectedType,
          );
          if (err) {
            throw new Error(err);
          }

          await partialConfig.refreshAuth(
            settings.merged.security.auth.selectedType,
          );
        } catch (err) {
          console.error('Error authenticating:', err);
          process.exit(1);
        }
      }
      let stdinData = '';
      if (!process.stdin.isTTY) {
        stdinData = await readStdin();
      }

      // This function is a copy of the one from sandbox.ts
      // It is moved here to decouple sandbox.ts from the CLI's argument structure.
      const injectStdinIntoArgs = (
        args: string[],
        stdinData?: string,
      ): string[] => {
        const finalArgs = [...args];
        if (stdinData) {
          const promptIndex = finalArgs.findIndex(
            (arg) => arg === '--prompt' || arg === '-p',
          );
          if (promptIndex > -1 && finalArgs.length > promptIndex + 1) {
            // 如果有 prompt 参数，将标准输入前置到其中
            // If there's a prompt argument, prepend stdin to it
            finalArgs[promptIndex + 1] =
              `${stdinData}\n\n${finalArgs[promptIndex + 1]}`;
          } else {
            // 如果没有 prompt 参数，将标准输入作为 prompt
            // If there's no prompt argument, add stdin as the prompt
            finalArgs.push('--prompt', stdinData);
          }
        }
        return finalArgs;
      };

      const sandboxArgs = injectStdinIntoArgs(process.argv, stdinData);

      // 启动沙箱进程
      await relaunchOnExitCode(() =>
        start_sandbox(sandboxConfig, memoryArgs, partialConfig, sandboxArgs),
      );
      process.exit(0);
    } else {
      // 重启应用，确保有一个可以内部重启的子进程
      // Relaunch app so we always have a child process that can be internally
      // restarted if needed.
      await relaunchAppInChildProcess(memoryArgs, []);
    }
  }

  // 已经处理完可能启动子进程来运行 Qwen Code CLI 的逻辑
  // 现在可以安全执行可能有副作用的昂贵初始化
  // We are now past the logic handling potentially launching a child process
  // to run Gemini CLI. It is now safe to perform expensive initialization that
  // may have side effects.
  {
    // 加载扩展和最终配置
    const extensionEnablementManager = new ExtensionEnablementManager(
      ExtensionStorage.getUserExtensionsDir(),
      argv.extensions,
    );
    const extensions = loadExtensions(extensionEnablementManager);
    const config = await loadCliConfig(
      settings.merged,
      extensions,
      extensionEnablementManager,
      sessionId,
      argv,
    );

    // 如果请求列出扩展，则输出已安装的扩展并退出
    if (config.getListExtensions()) {
      console.log('Installed extensions:');
      for (const extension of extensions) {
        console.log(`- ${extension.config.name}`);
      }
      process.exit(0);
    }

    const wasRaw = process.stdin.isRaw;
    let kittyProtocolDetectionComplete: Promise<boolean> | undefined;
    if (config.isInteractive() && !wasRaw && process.stdin.isTTY) {
      // 尽早设置为避免输入中出现意外字符
      // Set this as early as possible to avoid spurious characters from
      // input showing up in the output.
      process.stdin.setRawMode(true);

      // This cleanup isn't strictly needed but may help in certain situations.
      process.on('SIGTERM', () => {
        process.stdin.setRawMode(wasRaw);
      });
      process.on('SIGINT', () => {
        process.stdin.setRawMode(wasRaw);
      });

      // 在启动时检测并启用 Kitty 键盘协议
      // Detect and enable Kitty keyboard protocol once at startup.
      kittyProtocolDetectionComplete = detectAndEnableKittyProtocol();
    }

    setMaxSizedBoxDebugging(isDebugMode);

    const initializationResult = await initializeApp(config, settings);

    // 如果选择了 Google 登录认证方式且抑制浏览器启动，则预先获取 OAuth 客户端
    if (
      settings.merged.security?.auth?.selectedType ===
        AuthType.LOGIN_WITH_GOOGLE &&
      config.isBrowserLaunchSuppressed()
    ) {
      // 在应用呈现前执行 OAuth，以便可以复制链接
      // Do oauth before app renders to make copying the link possible.
      await getOauthClient(settings.merged.security.auth.selectedType, config);
    }

    // 如果启用了 Zed 集成，则运行 Zed 集成
    if (config.getExperimentalZedIntegration()) {
      return runZedIntegration(config, settings, extensions, argv);
    }

    let input = config.getQuestion();
    const startupWarnings = [
      ...(await getStartupWarnings()),
      ...(await getUserStartupWarnings({
        workspaceRoot: process.cwd(),
        useRipgrep: settings.merged.tools?.useRipgrep ?? true,
        useBuiltinRipgrep: settings.merged.tools?.useBuiltinRipgrep ?? true,
      })),
    ];

    // 渲染 UI，传递必要的配置值。检查是否有命令行问题。
    // Render UI, passing necessary config values. Check that there is no command line question.
    if (config.isInteractive()) {
      // 需要完成 kitty 检测才能启动交互式 UI
      // Need kitty detection to be complete before we can start the interactive UI.
      await kittyProtocolDetectionComplete;
      await startInteractiveUI(
        config,
        settings,
        startupWarnings,
        process.cwd(),
        initializationResult,
      );
      return;
    }

    await config.initialize();

    // 如果不是 TTY，则从 stdin 读取
    // 适用于直接将输入管道到命令的情况
    // If not a TTY, read from stdin
    // This is for cases where the user pipes input directly into the command
    if (!process.stdin.isTTY) {
      const stdinData = await readStdin();
      if (stdinData) {
        input = `${stdinData}\n\n${input}`;
      }
    }
    if (!input) {
      console.error(
        `No input provided via stdin. Input can be provided by piping data into gemini or using the --prompt option.`,
      );
      process.exit(1);
    }

    const prompt_id = Math.random().toString(16).slice(2);
    logUserPrompt(config, {
      'event.name': 'user_prompt',
      'event.timestamp': new Date().toISOString(),
      prompt: input,
      prompt_id,
      auth_type: config.getContentGeneratorConfig()?.authType,
      prompt_length: input.length,
    });

    const nonInteractiveConfig = await validateNonInteractiveAuth(
      settings.merged.security?.auth?.selectedType,
      settings.merged.security?.auth?.useExternal,
      config,
      settings,
    );

    if (config.getDebugMode()) {
      console.log('Session ID: %s', sessionId);
    }

    // 运行非交互式命令
    await runNonInteractive(nonInteractiveConfig, settings, input, prompt_id);
    // 在 process.exit 之前调用清理，否则清理不会运行
    // Call cleanup before process.exit, which causes cleanup to not run
    await runExitCleanup();
    process.exit(0);
  }
}

/**
 * 设置终端窗口标题
 * @param title 窗口标题
 * @param settings 用户设置
 */
function setWindowTitle(title: string, settings: LoadedSettings) {
  if (!settings.merged.ui?.hideWindowTitle) {
    const windowTitle = computeWindowTitle(title);
    process.stdout.write(`\x1b]2;${windowTitle}\x07`);

    process.on('exit', () => {
      process.stdout.write(`\x1b]2;\x07`);
    });
  }
}
