// selftest 结果校验: 本地 npm test 与 CI 打包验收共用同一组关键断言
const fs = require('fs');
const os = require('os');
const path = require('path');

const NEED = ['state0', 'state1', 'state2', 'state3', 'state4', 'state5', '"scrollTop":400', 'rowProbe', 'rows5', 'done'];

// 返回错误描述; 全部命中时返回 null
function check(logPath) {
    if (!fs.existsSync(logPath)) {
        return '缺少 result.log';
    }
    const text = fs.readFileSync(logPath, 'utf8');
    const missing = NEED.filter((k) => !text.includes(k));
    return missing.length ? 'result.log 缺少关键断言: ' + missing.join(', ') : null;
}

if (require.main === module) {
    const logPath = process.argv[2] || path.join(os.tmpdir(), 'miscjar-selftest', 'result.log');
    const err = check(logPath);
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log('selftest 断言全部通过: ' + logPath);
}

module.exports = { check };
