/**
 * 配置加载器
 *
 * 加载 .studio/config.yaml 配置文件
 */
export interface StudioConfig {
    apiUrl?: string;
    companyId?: number;
    format?: string;
    timeout?: number;
}
/**
 * 加载配置文件
 */
export declare function loadConfig(path?: string): StudioConfig;
/**
 * 获取当前配置
 */
export declare function getConfig(): StudioConfig;
/**
 * 保存配置文件
 */
export declare function saveConfig(config: Partial<StudioConfig>, path?: string): void;
//# sourceMappingURL=config.d.ts.map