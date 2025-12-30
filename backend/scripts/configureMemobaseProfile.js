/**
 * 配置 Memobase 用户画像
 *
 * 使用方法：
 * node scripts/configureMemobaseProfile.js
 */

require('dotenv').config();

// 医美咨询场景的用户画像配置
// 使用 additional_user_profiles 保留默认画像（兴趣爱好等），同时添加医美专用字段
const PROFILE_CONFIG = `
additional_user_profiles:
  # 基本信息
  - topic: "basic_info"
    sub_topics:
      - name: "name"
        description: "用户的姓名或称呼"
      - name: "gender"
        description: "用户性别"
      - name: "age_range"
        description: "用户年龄段，如20-30岁、30-40岁"

  # 咨询偏好
  - topic: "consultation_preferences"
    sub_topics:
      - name: "interested_procedures"
        description: "用户感兴趣的整形项目，如双眼皮、隆鼻、瘦脸、除皱、美白、祛斑、丰胸、吸脂等"
      - name: "budget_range"
        description: "用户的预算范围，如1万以内、1-3万、3-5万、5万以上"
      - name: "timeline"
        description: "用户计划的手术时间，如近期想做、3个月内、半年内、只是了解"

  # 关注点和顾虑
  - topic: "concerns"
    sub_topics:
      - name: "main_concerns"
        description: "用户最关心的问题，如安全性、效果自然度、恢复期长短、是否需要请假"
      - name: "fears"
        description: "用户的担忧和顾虑，如怕疼、怕留疤、怕失败、怕被人看出来"
        update_description: "追加新的担忧，不要覆盖之前记录的担忧"

  # 身体状况
  - topic: "health_info"
    sub_topics:
      - name: "allergies"
        description: "用户的过敏史，如药物过敏、麻醉过敏等"
      - name: "medical_history"
        description: "用户的病史，如高血压、糖尿病、心脏病等"
      - name: "previous_procedures"
        description: "用户之前做过的整形或医美项目"
        update_description: "追加新信息，保留所有历史记录"

  # 咨询进展
  - topic: "consultation_progress"
    sub_topics:
      - name: "discussed_topics"
        description: "已经详细讨论过的项目和话题"
        update_description: "追加新话题，保留所有历史讨论记录"
      - name: "answered_questions"
        description: "用户已经问过并得到解答的问题"
        update_description: "追加新问题，不覆盖旧记录"
      - name: "decision_status"
        description: "用户当前的决策状态，如还在考虑、基本决定、需要更多信息"

  # 偏好和习惯
  - topic: "preferences"
    sub_topics:
      - name: "communication_style"
        description: "用户偏好的沟通方式，如喜欢详细解释、喜欢简洁回答、喜欢看案例"
      - name: "decision_factors"
        description: "影响用户决策的关键因素，如价格、医生经验、口碑评价"
`;

async function configureProfile() {
  console.log('=== 配置 Memobase 用户画像 ===\n');

  const projectUrl = process.env.MEMOBASE_PROJECT_URL;
  const apiKey = process.env.MEMOBASE_API_KEY;

  if (!projectUrl || !apiKey) {
    console.error('错误: 缺少 Memobase 配置');
    console.error('请在 .env 中设置 MEMOBASE_PROJECT_URL 和 MEMOBASE_API_KEY');
    process.exit(1);
  }

  console.log('Project URL:', projectUrl);
  console.log('API Key:', apiKey.substring(0, 20) + '...\n');

  try {
    // 使用 fetch API 调用 Memobase
    const response = await fetch(`${projectUrl}/api/v1/project/profile_config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        profile_config: PROFILE_CONFIG
      })
    });

    const result = await response.json();

    if (response.ok && result.errno === 0) {
      console.log('✅ 用户画像配置成功！\n');
      console.log('配置的画像类别:');
      console.log('  - basic_info: 基本信息（姓名、性别、年龄）');
      console.log('  - consultation_preferences: 咨询偏好（感兴趣项目、预算、时间）');
      console.log('  - concerns: 关注点和顾虑');
      console.log('  - health_info: 健康信息（过敏史、病史、既往手术）');
      console.log('  - consultation_progress: 咨询进展');
      console.log('  - preferences: 用户偏好');
    } else {
      console.error('❌ 配置失败:', result.errmsg || JSON.stringify(result));
    }
  } catch (error) {
    console.error('❌ 请求失败:', error.message);

    // 如果是网络错误，尝试使用 SDK
    console.log('\n尝试使用 SDK 方式...');
    try {
      const { MemoBaseClient } = await import('@memobase/memobase');
      const client = new MemoBaseClient(projectUrl, apiKey);

      // 检查是否有 updateConfig 方法
      if (typeof client.updateConfig === 'function') {
        await client.updateConfig(PROFILE_CONFIG);
        console.log('✅ 通过 SDK 配置成功！');
      } else {
        console.log('SDK 不支持 updateConfig 方法');
        console.log('请通过 Memobase 控制台手动配置');
      }
    } catch (sdkError) {
      console.error('SDK 方式也失败:', sdkError.message);
    }
  }
}

// 显示当前配置
function showConfig() {
  console.log('=== 用户画像配置内容 ===\n');
  console.log(PROFILE_CONFIG);
}

// 主函数
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--show')) {
    showConfig();
  } else {
    await configureProfile();
  }
}

main().catch(console.error);
