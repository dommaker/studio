/**
 * getErrorMessage 正本已下沉至 @dommaker/studio-shared（utils/get-error-message.ts，
 * 语义不变：Error → message；string → 原文；其他 → 'Unknown error'）。
 * 本文件保留 re-export，消费方 import 路径不动。
 */
export { getErrorMessage } from '@dommaker/studio-shared';
