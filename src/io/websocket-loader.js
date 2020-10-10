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

import Log from '../utils/logger.js';
import {BaseLoader, LoaderStatus, LoaderErrors} from './loader.js';
import {RuntimeException} from '../utils/exception.js';

// For FLV over WebSocket live stream

/**
 * WebSocketLoader类-WebSocket实时流加载器
 * isSupported() 是否支持 WebSocket：全局有 WebSocket 属性  
 * TAG 实例构造器名称  
 * _needStash 需要暂存区，重写为 true  
 * _requestAbort 请求终止标志位，初始化为 false  
 * _ws WebSocket 实例，初始化为 null  
 * _receivedLength 已接收长度，初始化为 0
 */
class WebSocketLoader extends BaseLoader {

    static isSupported() {
        try {
            return (typeof self.WebSocket !== 'undefined');
        } catch (e) {
            return false;
        }
    }
    constructor() {
        super('websocket-loader');
        this.TAG = 'WebSocketLoader';

        this._needStash = true;

        this._ws = null;
        this._requestAbort = false;
        this._receivedLength = 0;
    }
    /**
     * 销毁实例
     */
    destroy() {
        if (this._ws) {
            this.abort();
        }
        super.destroy();
    }
    /**
     * 
     * @param {*} dataSource 
     */
    open(dataSource) {
        try {
            // new 一个 WS 实例，传入 dataSource 的 url，保存在实例的 WS 实例属性中
            let ws = this._ws = new self.WebSocket(dataSource.url);
            // 设置实例 WS 实例的 binaryType 属性为 arraybuffer
            ws.binaryType = 'arraybuffer';
            // 对实例 WS 实例的四个事件进行监听
            ws.onopen = this._onWebSocketOpen.bind(this);
            ws.onclose = this._onWebSocketClose.bind(this);
            ws.onmessage = this._onWebSocketMessage.bind(this);
            ws.onerror = this._onWebSocketError.bind(this);

            this._status = LoaderStatus.kConnecting;
        } catch (e) {
            this._status = LoaderStatus.kError;

            let info = {code: e.code, msg: e.message};

            if (this._onError) {
                this._onError(LoaderErrors.EXCEPTION, info);
            } else {
                throw new RuntimeException(info.msg);
            }
        }
    }
    /**
     * 终止
     */
    abort() {
        let ws = this._ws;
        // 如果实例的 WS 实例的 readyState 为 0 或者 1，就将实例的请求终止标志位设为 true，然后关闭 WS 实例
        if (ws && (ws.readyState === 0 || ws.readyState === 1)) {  // CONNECTING || OPEN
            this._requestAbort = true;
            ws.close();
        }

        this._ws = null;//清除ws实例
        this._status = LoaderStatus.kComplete;//状态改为以完成
    }
    /**
     * WS 打开事件处理函数
     * @param {*} e 
     */
    _onWebSocketOpen(e) {
        this._status = LoaderStatus.kBuffering;//设置状态为缓冲中
    }
    /**
     * WS 关闭事件处理函数
     * @param {*} e 
     */
    _onWebSocketClose(e) {
        if (this._requestAbort === true) {
            this._requestAbort = false;
            return;
        }

        this._status = LoaderStatus.kComplete;
        //  如果实例存在完成事件处理函数，执行之，传入 0 和 实例接收长度 - 1
        if (this._onComplete) {
            this._onComplete(0, this._receivedLength - 1);
        }
    }
    /**
     * WS 接收消息事件处理函数
     * @param {*} e 
     */
    _onWebSocketMessage(e) {
        // 如果数据是ArrayBuffer类型，直接传
        if (e.data instanceof ArrayBuffer) {
            this._dispatchArrayBuffer(e.data);
        } else if (e.data instanceof Blob) {
            // 如果数据是Blob类型，就转为ArrayBuffer 再传
            let reader = new FileReader();
            reader.onload = () => {
                this._dispatchArrayBuffer(reader.result);
            };
            reader.readAsArrayBuffer(e.data);
        } else {
            // 如果不是以上两种就报错
            this._status = LoaderStatus.kError;
            let info = {code: -1, msg: 'Unsupported WebSocket message type: ' + e.data.constructor.name};

            if (this._onError) {
                this._onError(LoaderErrors.EXCEPTION, info);
            } else {
                throw new RuntimeException(info.msg);
            }
        }
    }
    /**
     * 处理数据 和fetch一样都将数据给_onDataArrival
     * @param {*} arraybuffer 
     */
    _dispatchArrayBuffer(arraybuffer) {
        let chunk = arraybuffer;
        let byteStart = this._receivedLength;
        this._receivedLength += chunk.byteLength;

        if (this._onDataArrival) {
            this._onDataArrival(chunk, byteStart, this._receivedLength);
        }
    }
    /**
     * WS 出错事件处理函数
     * @param {*} e 
     */
    _onWebSocketError(e) {
        this._status = LoaderStatus.kError;

        let info = {
            code: e.code,
            msg: e.message
        };

        if (this._onError) {
            this._onError(LoaderErrors.EXCEPTION, info);
        } else {
            throw new RuntimeException(info.msg);
        }
    }

}

export default WebSocketLoader;