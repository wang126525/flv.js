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

// For FireFox browser which supports `xhr.responseType = 'moz-chunked-arraybuffer'`

/**
 * MozChunkedLoader类-火狐加载器
 * 1.1 isSupported() 是否支持火狐，核心是判断 XMLHttpRequest 对象的响应类型是不是 moz-chunked-arraybuffer 
 * TAG 实例构造器名称 
 * _seekHandler 搜索处理函数 
 * _needStash 需要暂存区，重写为 true 
 * _xhr XMLHttpRequest 实例 
 * _requestAbort 请求终止标志位，初始化为 false 
 * _contentLength 内容长度，初始化为 null 
 * _receivedLength 已接收长度，初始化为 0
 */
class MozChunkedLoader extends BaseLoader {

    static isSupported() {
        try {
            let xhr = new XMLHttpRequest();
            // Firefox 37- requires .open() to be called before setting responseType
            xhr.open('GET', 'https://example.com', true);
            xhr.responseType = 'moz-chunked-arraybuffer';
            return (xhr.responseType === 'moz-chunked-arraybuffer');
        } catch (e) {
            Log.w('MozChunkedLoader', e.message);
            return false;
        }
    }

    constructor(seekHandler, config) {
        super('xhr-moz-chunked-loader');
        this.TAG = 'MozChunkedLoader';

        this._seekHandler = seekHandler;
        this._config = config;
        this._needStash = true;

        this._xhr = null;
        this._requestAbort = false;
        this._contentLength = null;
        this._receivedLength = 0;
    }
    /**
     * 销毁实例
     */
    destroy() {
        if (this.isWorking()) {
            this.abort();
        }
        if (this._xhr) {
            this._xhr.onreadystatechange = null;
            this._xhr.onprogress = null;
            this._xhr.onloadend = null;
            this._xhr.onerror = null;
            this._xhr = null;
        }
        super.destroy();
    }
    /**
     * 打开数据源开始加载
     * @param {*} dataSource 
     * @param {*} range 
     */
    open(dataSource, range) {
        this._dataSource = dataSource;
        this._range = range;

        let sourceURL = dataSource.url;
        if (this._config.reuseRedirectedURL && dataSource.redirectedURL != undefined) {
            sourceURL = dataSource.redirectedURL;
        }

        let seekConfig = this._seekHandler.getConfig(sourceURL, range);
        this._requestURL = seekConfig.url;
        // 创建请求实例
        let xhr = this._xhr = new XMLHttpRequest();
        xhr.open('GET', seekConfig.url, true);
        // 设置响应的类型
        xhr.responseType = 'moz-chunked-arraybuffer';
        // 对 xhr 的四个事件进行监听
        xhr.onreadystatechange = this._onReadyStateChange.bind(this);
        xhr.onprogress = this._onProgress.bind(this);
        xhr.onloadend = this._onLoadEnd.bind(this);
        xhr.onerror = this._onXhrError.bind(this);

        // cors is auto detected and enabled by xhr

        // withCredentials is disabled by default
        // 如果 dataSource 的证书属性为 true，设置 xhr 的 withCredentials 属性为 true
        if (dataSource.withCredentials) {
            xhr.withCredentials = true;
        }
        // 设置请求头 从搜索配置那取到的header信息
        if (typeof seekConfig.headers === 'object') {
            let headers = seekConfig.headers;

            for (let key in headers) {
                if (headers.hasOwnProperty(key)) {
                    xhr.setRequestHeader(key, headers[key]);
                }
            }
        }

        // add additional headers
        // 设置请求头 从传入的配置中设置
        if (typeof this._config.headers === 'object') {
            let headers = this._config.headers;

            for (let key in headers) {
                if (headers.hasOwnProperty(key)) {
                    xhr.setRequestHeader(key, headers[key]);
                }
            }
        }

        this._status = LoaderStatus.kConnecting;
        xhr.send();
    }
    /**
     * 终止加载
     */
    abort() {
        this._requestAbort = true;
        if (this._xhr) {
            this._xhr.abort();//终止xhr请求
        }
        this._status = LoaderStatus.kComplete;
    }
    /**
     * readyState 属性改变事件处理函数
     * @param {*} e 
     */
    _onReadyStateChange(e) {
        let xhr = e.target;

        if (xhr.readyState === 2) {  // HEADERS_RECEIVED
            if (xhr.responseURL != undefined && xhr.responseURL !== this._requestURL) {
                if (this._onURLRedirect) {
                    let redirectedURL = this._seekHandler.removeURLParameters(xhr.responseURL);
                    this._onURLRedirect(redirectedURL);
                }
            }
            // 如果请求报错
            if (xhr.status !== 0 && (xhr.status < 200 || xhr.status > 299)) {
                this._status = LoaderStatus.kError;
                if (this._onError) {
                    this._onError(LoaderErrors.HTTP_STATUS_CODE_INVALID, {code: xhr.status, msg: xhr.statusText});
                } else {
                    throw new RuntimeException('MozChunkedLoader: Http code invalid, ' + xhr.status + ' ' + xhr.statusText);
                }
            } else {
                // 否则 改变状态为缓冲中
                this._status = LoaderStatus.kBuffering;
            }
        }
    }
    /**
     *  进度事件处理函数
     * @param {*} e 
     */
    _onProgress(e) {
        // 报错就退出
        if (this._status === LoaderStatus.kError) {
            // Ignore error response
            return;
        }
        // 初始时执行一次
        if (this._contentLength === null) {
            if (e.total !== null && e.total !== 0) {
                this._contentLength = e.total;//设置实例的内容长度为 e.total
                // 如果实例存在已知内容长度事件处理函数，执行之，传入实例的内容长度
                if (this._onContentLengthKnown) {
                    this._onContentLengthKnown(this._contentLength);
                }
            }
        }
        // 和fetch一样处理数据 并传给_onDataArrival函数
        let chunk = e.target.response;
        let byteStart = this._range.from + this._receivedLength;
        this._receivedLength += chunk.byteLength;

        if (this._onDataArrival) {
            this._onDataArrival(chunk, byteStart, this._receivedLength);
        }
    }
    /**
     * 加载停止事件处理函数
     * @param {*} e 
     */
    _onLoadEnd(e) {
        if (this._requestAbort === true) {
            this._requestAbort = false;
            return;
        } else if (this._status === LoaderStatus.kError) {
            return;
        }
        // 状态改为完成
        this._status = LoaderStatus.kComplete;
        if (this._onComplete) {
            this._onComplete(this._range.from, this._range.from + this._receivedLength - 1);
        }
    }
    /**
     * 出错事件处理函数
     * @param {*} e 
     */
    _onXhrError(e) {
        this._status = LoaderStatus.kError;
        let type = 0;
        let info = null;
        // 过早结束错误
        if (this._contentLength && e.loaded < this._contentLength) {
            type = LoaderErrors.EARLY_EOF;
            info = {code: -1, msg: 'Moz-Chunked stream meet Early-Eof'};
        } else {
            type = LoaderErrors.EXCEPTION;
            info = {code: -1, msg: e.constructor.name + ' ' + e.type};
        }

        if (this._onError) {
            this._onError(type, info);
        } else {
            throw new RuntimeException(info.msg);
        }
    }

}

export default MozChunkedLoader;