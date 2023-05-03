const text = `#記事
- 業務阿雷反映客戶的客屬中有大概20位消費者信用卡付款失敗的情況。
- 需要安排會議討論對策。
- 客戶提出了啤酒大賽的計畫。

#待辦
- 安排會議討論對策。
- 與團隊一起思考對策。`;

const [memo, todo] = text.split(/\n#(?:記事|待辦)\n/);

const result = memo.replace('aaa', '').replace(/^\s*$\n/gm, '').trim();
const todos = todo.replace(/^\s*$\n/gm, '').trim();

console.log(result); // 输出：業務阿雷反映客戶的客屬中有大概20位消費者信用卡付款失敗的情況。\n- 需要安排會議討論對策。\n- 客戶提出了啤酒大賽的計畫。
console.log(todos); // 输出：安排會議討論對策。\n- 與團隊一起思考對策。
