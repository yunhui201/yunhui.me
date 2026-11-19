/** Build metadata is public and contains no machine paths, environment values or credentials. */
export interface BuildInfo { id: string; builtAt: string; revision: string; channel: 'local' | 'release' }
declare const __YUNHUI_BUILD_INFO__: BuildInfo;
export const buildInfo: BuildInfo | undefined = typeof __YUNHUI_BUILD_INFO__ === 'undefined' ? undefined : __YUNHUI_BUILD_INFO__;
