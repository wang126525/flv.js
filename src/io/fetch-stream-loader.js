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
import Browser from '../utils/browser.js';
import {BaseLoader, LoaderStatus, LoaderErrors} from './loader.js';
import {RuntimeException} from '../utils/exception.js';

/* fetch + stream IO loader. Currently working on chrome 43+.
 * fetch provides a better alternative http API to XMLHttpRequest
 *
 * fetch spec   https://fetch.spec.whatwg.org/
 * stream spec  https://streams.spec.whatwg.org/
 */

 /**
  * FetchStreamLoader类-fetch加载器
  * isSupported() 是否支持 fetch 流加载：浏览器非 IE、全局有 fetch 方法和 ReadableStream 属性  
  * TAG 实例构造器名称  
  * _seekHandler 搜索处理函数  
  * _needStash 需要暂存区，重写为 true 
  * _requestAbort 请求终止标志位，初始化为 false  
  * _contentLength 内容长度，初始化为 null  
  * _receivedLength 已接收长度，初始化为 0
  */
class FetchStreamLoader extends BaseLoader {

    static isSupported() {
        try {
            // fetch + stream is broken on Microsoft Edge. Disable before build 15048.
            // see https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/8196907/
            // Fixed in Jan 10, 2017. Build 15048+ removed from blacklist.
            let isWorkWellEdge = Browser.msedge && Browser.version.minor >= 15048;
            let browserNotBlacklisted = Browser.msedge ? isWorkWellEdge : true;
            return (self.fetch && self.ReadableStream && browserNotBlacklisted);
        } catch (e) {
            return false;
        }
    }

    constructor(seekHandler, config) {
        super('fetch-stream-loader');
        this.TAG = 'FetchStreamLoader';

        this._seekHandler = seekHandler;
        this._config = config;
        this._needStash = true;

        this._requestAbort = false;//请求终止标志位，初始化为 false
        this._contentLength = null;//内容长度，初始化为 null
        this._receivedLength = 0;//已接收长度，初始化为 0
    }
    /**
     * 销毁实例 如果实例处于工作中，终止加载 执行基类的 destroy 方法
     */
    destroy() {
        if (this.isWorking()) {
            this.abort();
        }
        super.destroy();
    }
    /**
     * 加载数据
     * @param {*} dataSource 
     * @param {*} range 
     */
    open(dataSource, range) {
        // 设置实例的数据源为 dataSource，实例的范围为 range
        this._dataSource = dataSource;
        this._range = range;
        
        let sourceURL = dataSource.url;
        if (this._config.reuseRedirectedURL && dataSource.redirectedURL != undefined) {
            sourceURL = dataSource.redirectedURL;
        }
        // 获取实例的搜索处理函数配置
        let seekConfig = this._seekHandler.getConfig(sourceURL, range);
        // new 一个 Headers 实例（之后简称 headers）
        let headers = new self.Headers();

        if (typeof seekConfig.headers === 'object') {
            let configHeaders = seekConfig.headers;
            for (let key in configHeaders) {
                if (configHeaders.hasOwnProperty(key)) {
                    headers.append(key, configHeaders[key]);
                }
            }
        }

        let params = {
            method: 'GET',
            headers: headers,
            mode: 'cors',
            cache: 'default',
            // The default policy of Fetch API in the whatwg standard
            // Safari incorrectly indicates 'no-referrer' as default policy, fuck it
            referrerPolicy: 'no-referrer-when-downgrade'
        };

        // add additional headers
        if (typeof this._config.headers === 'object') {
            for (let key in this._config.headers) {
                headers.append(key, this._config.headers[key]);
            }
        }

        // 如果 dataSource 的跨域属性为 false，设置参数的模式为 same-origin
        if (dataSource.cors === false) {
            // no-cors means 'disregard cors policy', which can only be used in ServiceWorker
            params.mode = 'same-origin';
        }

        // 如果 dataSource 的证书属性为 false，设置参数的证书为 include
        if (dataSource.withCredentials) {
            params.credentials = 'include';
        }

        // referrerPolicy from config
        if (dataSource.referrerPolicy) {
            params.referrerPolicy = dataSource.referrerPolicy;
        }
        //  设置实例的状态为连接中
        this._status = LoaderStatus.kConnecting;
        // fetch请求
        self.fetch(seekConfig.url, params).then((res) => {
            // 如果实例的请求终止标志位为 true,恢复初始重置，退出
            if (this._requestAbort) {
                this._requestAbort = false;
                this._status = LoaderStatus.kIdle;
                return;
            }
            // 如果响应数据接收成功且状态码为 2xx
            if (res.ok && (res.status >= 200 && res.status <= 299)) {
                if (res.url !== seekConfig.url) {
                    if (this._onURLRedirect) {
                        let redirectedURL = this._seekHandler.removeURLParameters(res.url);
                        this._onURLRedirect(redirectedURL);
                    }
                }

                let lengthHeader = res.headers.get('Content-Length');
                // 如果响应数据头长度不为 0 且实例存在已知内容长度事件处理函数，执行之
                if (lengthHeader != null) {
                    this._contentLength = parseInt(lengthHeader);
                    if (this._contentLength !== 0) {
                        if (this._onContentLengthKnown) {
                            this._onContentLengthKnown(this._contentLength);
                        }
                    }
                }
                // 关键操作 抽取数据
                return this._pump.call(this, res.body.getReader());
            } else {
                // 改为错误状态
                this._status = LoaderStatus.kError;
                if (this._onError) {
                    // 如果实例存在出错事件处理函数，执行之，传入 HTTP 状态码错误和错误数据
                    this._onError(LoaderErrors.HTTP_STATUS_CODE_INVALID, {code: res.status, msg: res.statusText});
                } else {
                    throw new RuntimeException('FetchStreamLoader: Http code invalid, ' + res.status + ' ' + res.statusText);
                }
            }
        }).catch((e) => {
            // 若捕捉到错误
            this._status = LoaderStatus.kError;
            if (this._onError) {
                this._onError(LoaderErrors.EXCEPTION, {code: -1, msg: e.message});
            } else {
                throw e;
            }
        });
    }
    /**
     * 终止加载器：设置当前实例的请求终止标志位为 true
     */
    abort() {
        this._requestAbort = true;
    }
    /**
     * 抽取数据 传入 reader 参数，返回一个 Promise，为 reader 调用 read() 后的 result
     * @param {*} reader fetch流的阅读器
     */
    _pump(reader) {  // ReadableStreamReader
        return reader.read().then((result) => {
            //result.done reader带有的属性，为true则数据传输完毕
            if (result.done) {
                // First check received length
                // 如果头里面的content大小存在，并且已接收的长度小于content大小，说明数据没传完就结束了
                if (this._contentLength !== null && this._receivedLength < this._contentLength) {
                    // Report Early-EOF
                    // 报错 提早结束
                    this._status = LoaderStatus.kError;
                    let type = LoaderErrors.EARLY_EOF;
                    let info = {code: -1, msg: 'Fetch stream meet Early-EOF'};
                    if (this._onError) {
                        this._onError(type, info);
                    } else {
                        throw new RuntimeException(info.msg);
                    }
                } else {
                    // 否则就是正常传输完成 状态改为完成
                    this._status = LoaderStatus.kComplete;
                    if (this._onComplete) {
                        // 如果实例存在完成事件处理函数，执行之，传入实例范围起点和实例范围起点 + 实例接受数据长度 - 1
                        this._onComplete(this._range.from, this._range.from + this._receivedLength - 1);
                    }
                }
            // 否则没有传输结束 递归调用该函数 直到result.done==true
            } else {
                // 如果实例的请求终止标志位为 true
                if (this._requestAbort === true) {
                    this._requestAbort = false;
                    // 设置实例的状态为完成
                    this._status = LoaderStatus.kComplete;
                    // 返回 reader.cancel()
                    return reader.cancel();
                }
                // 没有终止就设置状态为 正在缓冲中
                this._status = LoaderStatus.kBuffering;

                // 给实例的接收长度加上 result.value.buffer 的字节长度
                let chunk = result.value.buffer;
                console.log('result.value.buffer',chunk);
                let byteStart = this._range.from + this._receivedLength;
                this._receivedLength += chunk.byteLength;

                // 如果实例存在完成数据到达处理函数，执行之，传入 result.value.buffer、实例范围起点 + 实例接收长度、实例接收长度
                if (this._onDataArrival) {
                    this._onDataArrival(chunk, byteStart, this._receivedLength);
                }

                this._pump(reader);
            }
        }).catch((e) => {
            // 捕获错误
            if (e.code === 11 && Browser.msedge) {  // InvalidStateError on Microsoft Edge
                // Workaround: Edge may throw InvalidStateError after ReadableStreamReader.cancel() call
                // Ignore the unknown exception.
                // Related issue: https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/11265202/
                return;
            }

            this._status = LoaderStatus.kError;
            let type = 0;
            let info = null;

            if ((e.code === 19 || e.message === 'network error') && // NETWORK_ERR
                (this._contentLength === null ||
                (this._contentLength !== null && this._receivedLength < this._contentLength))) {
                type = LoaderErrors.EARLY_EOF;
                info = {code: e.code, msg: 'Fetch stream meet Early-EOF'};
            } else {
                type = LoaderErrors.EXCEPTION;
                info = {code: e.code, msg: e.message};
            }

            if (this._onError) {
                this._onError(type, info);
            } else {
                throw new RuntimeException(info.msg);
            }
        });
    }

}

export default FetchStreamLoader;
