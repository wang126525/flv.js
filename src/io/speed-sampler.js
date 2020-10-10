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

// Utility class to calculate realtime network I/O speed

// SpeedSampler类-实时网速计算器
/**
 * 属性：
 * _firstCheckpoint 首次检查点
 * _lastCheckpoint 结尾检查点
 * _intervalBytes 间隔字节数
 * _totalBytes 总字节数
 * _lastSecondBytes 最后一秒字节数
 * _now 获取当前时间函数
 */
class SpeedSampler {
    constructor() {
        // milliseconds
        this._firstCheckpoint = 0;
        this._lastCheckpoint = 0;
        this._intervalBytes = 0;
        this._totalBytes = 0;
        this._lastSecondBytes = 0;

        // compatibility detection
        if (self.performance && self.performance.now) {
            this._now = self.performance.now.bind(self.performance);
        } else {
            this._now = Date.now;
        }
    }
    /**
     * 重置，其实就是让五个实例属性值全变成 0
     */
    reset() {
        this._firstCheckpoint = this._lastCheckpoint = 0;
        this._totalBytes = this._intervalBytes = 0;
        this._lastSecondBytes = 0;
    }
    /**
     * 增加字节数，传入 bytes 参数 在设立初始化检查点后，每次添加字节，都会更新结尾检查点，然后计算一次速率。所以，它是一段一段算速率的
     * @param {*} bytes 
     */
    addBytes(bytes) {
        if (this._firstCheckpoint === 0) {
            this._firstCheckpoint = this._now();//将实例首次检查点设为现在
            this._lastCheckpoint = this._firstCheckpoint;//将实例结尾检查点设为实例首次检查点
            this._intervalBytes += bytes;//将实例间隔字节数加上 bytes
            this._totalBytes += bytes;// 将实例总字节数加上 bytes
        //  如果当前时间 - 实例结尾检查点 < 1000
        } else if (this._now() - this._lastCheckpoint < 1000) {
            this._intervalBytes += bytes;
            this._totalBytes += bytes;
        } else {  // duration >= 1000
            this._lastSecondBytes = this._intervalBytes;
            this._intervalBytes = bytes;
            this._totalBytes += bytes;
            this._lastCheckpoint = this._now();
        }
    }
    /**
     * 当前速率，值为 1000 * 1024 * 间隔字节数/（当前时间 - 结尾检查点），但是为了防止大数溢出，还是（间隔字节数 /（当前时间 - 结尾检查点）/ 1000 ）/ 1024
     */
    get currentKBps() {
        this.addBytes(0);

        let durationSeconds = (this._now() - this._lastCheckpoint) / 1000;
        if (durationSeconds == 0) durationSeconds = 1;
        return (this._intervalBytes / durationSeconds) / 1024;
    }
    /**
     * 最后速率
     */
    get lastSecondKBps() {
        this.addBytes(0);
        // 如果实例的最后一秒字节数不为 0，返回实例最后一秒字节数 / 1024
        if (this._lastSecondBytes !== 0) {
            return this._lastSecondBytes / 1024;
        } else {  // lastSecondBytes === 0
            //  如果实例当前时间 - 实例结尾检查点 >= 500，返回实例当前速率
            if (this._now() - this._lastCheckpoint >= 500) {
                // if time interval since last checkpoint has exceeded 500ms
                // the speed is nearly accurate
                return this.currentKBps;
            } else {
                // We don't know
                return 0;
            }
        }
    }
    /**
     * 平均速率 值为（总字节数 /（当前时间 - 首次检查点）/ 1000 ）/ 1024
     */
    get averageKBps() {
        let durationSeconds = (this._now() - this._firstCheckpoint) / 1000;
        return (this._totalBytes / durationSeconds) / 1024;
    }

}

export default SpeedSampler;