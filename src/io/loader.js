/*
 * Copyright (C) 2016 Bilibili. All Rights Reserved.
 *
 * @author zheng qian <xqq@xqq.im>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {NotImplementedException} from '../utils/exception.js';
/**
 * 常量-加载器状态
 * kIdle 闲置  kConnecting 连接中  kBuffering 缓冲中  kError 出错  kComplete 完成
*/
export const LoaderStatus = {
    kIdle: 0,
    kConnecting: 1,
    kBuffering: 2,
    kError: 3,
    kComplete: 4
};
/**
 *OK 成功  EXCEPTION 其他错误  HTTP_STATUS_CODE_INVALID HTTP 状态码错误  CONNECTING_TIMEOUT 连接超时  EARLY_EOF 过早结束  UNRECOVERABLE_EARLY_EOF 不可恢复的过早结束
 */
export const LoaderErrors = {
    OK: 'OK',
    EXCEPTION: 'Exception',
    HTTP_STATUS_CODE_INVALID: 'HttpStatusCodeInvalid',
    CONNECTING_TIMEOUT: 'ConnectingTimeout',
    EARLY_EOF: 'EarlyEof',
    UNRECOVERABLE_EARLY_EOF: 'UnrecoverableEarlyEof'
};

/* Loader has callbacks which have following prototypes:
 *     function onContentLengthKnown(contentLength: number): void
 *     function onURLRedirect(url: string): void
 *     function onDataArrival(chunk: ArrayBuffer, byteStart: number, receivedLength: number): void
 *     function onError(errorType: number, errorInfo: {code: number, msg: string}): void
 *     function onComplete(rangeFrom: number, rangeTo: number): void
 */
/**
 * 数据加载器
 * 属性: 
 * _type 加载器类型
 * _status 加载器状态
 * _needStash 是否需要暂存区
 * _onContentLengthKnown 已知内容长度事件处理函数
 * _onDataArrival 数据抵达事件处理函数
 * _onError 出错事件处理函数
 * _onComplete 完成事件处理函数
 */
export class BaseLoader {

    constructor(typeName) {
        // 加载器类型初始化为构造函数传入的 typeName 参数，并且有对应的实例只读属性 type
        this._type = typeName || 'undefined';
        // 加载器状态初始化为闲置状态，并且有对应的实例只读属性 status
        this._status = LoaderStatus.kIdle;
        this._needStash = false; //是否需要暂存区
        // callbacks
        this._onContentLengthKnown = null;
        this._onURLRedirect = null;
        this._onDataArrival = null;
        this._onError = null;
        this._onComplete = null;
    }
    /**
     * 销毁加载器实例，就是将实例状态设为重置，四个事件处理函数设置为 null
     */
    destroy() {
        this._status = LoaderStatus.kIdle;
        this._onContentLengthKnown = null;
        this._onURLRedirect = null;
        this._onDataArrival = null;
        this._onError = null;
        this._onComplete = null;
    }
    /**
     * 获取加载器运行状态，根据加载器状态是连接中或者缓存中来判断
     */
    isWorking() {
        return this._status === LoaderStatus.kConnecting || this._status === LoaderStatus.kBuffering;
    }

    get type() {
        return this._type;
    }

    get status() {
        return this._status;
    }

    get needStashBuffer() {
        return this._needStash;
    }

    get onContentLengthKnown() {
        return this._onContentLengthKnown;
    }

    set onContentLengthKnown(callback) {
        this._onContentLengthKnown = callback;
    }

    get onURLRedirect() {
        return this._onURLRedirect;
    }

    set onURLRedirect(callback) {
        this._onURLRedirect = callback;
    }

    get onDataArrival() {
        return this._onDataArrival;
    }

    set onDataArrival(callback) {
        this._onDataArrival = callback;
    }

    get onError() {
        return this._onError;
    }

    set onError(callback) {
        this._onError = callback;
    }

    get onComplete() {
        return this._onComplete;
    }

    set onComplete(callback) {
        this._onComplete = callback;
    }

    // 打开数据源开始加载，报错---延迟到子类实现
    open(dataSource, range) {
        throw new NotImplementedException('Unimplemented abstract function!');
    }
    // 终止加载，报错---延迟到子类实现
    abort() {
        throw new NotImplementedException('Unimplemented abstract function!');
    }


}