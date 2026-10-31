import { openRuntime } from '../src/server/runtime.js';
const { store, dataDir } = await openRuntime(process.env.CONSOLE_DATA_DIR ?? 'data/live', process.env.CONSOLE_ADMIN_PASSWORD_FILE);
store.close();
console.log(`初始化完成。私有数据目录：${dataDir}`);
console.log('首次密码保存在该目录的 initial-password 文件中；若指定密码文件，则使用指定文件。');
