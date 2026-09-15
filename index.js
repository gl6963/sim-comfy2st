import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    saveChatConditional,
    this_chid,
    generateQuietPrompt,
} from '/script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { SlashCommandArgument } from '/scripts/slash-commands/SlashCommandArgument.js';
import { callGenericPopup, POPUP_TYPE } from '/scripts/popup.js';
import { saveBase64AsFile } from '/scripts/utils.js';

const MODULE_NAME = 'comfyui_drawer';

const EXTENSION_DIR = (function () {
    try {
        const url = new URL(import.meta.url);
        const parts = url.pathname.split('/scripts/extensions/')[1];
        if (parts) {
            return parts.substring(0, parts.lastIndexOf('/'));
        }
    } catch (e) {}
    return 'third-party/sim-comfy2st';
})();

const BUILTIN_PRESETS = [
    {
        id: 'preset_default',
        name: '默认情境 (单张)',
        contextScope: 'recent_n',
        contextCount: 3,
        sourceCharCard: true,
        sourceLorebook: false,
        sourceUserPersona: false,
        extractPrompt: "You are a Stable Diffusion prompt generator. Read the recent roleplay conversation context between {{char}} and {{user}}, and extract {{char}}'s current action, pose, facial expression, clothing condition, environment, lighting, and mood.\nOutput requirements:\n1. Output ONLY English Danbooru-style comma-separated tags.\n2. Do not repeat fixed character traits as they are handled globally.\n3. Output NO explanations, NO conversational words, ONLY tags.\nExample: sitting by window, holding tea cup, gentle smile, sunset lighting, indoor, cozy room",
        shotCount: 1,
        resolution: 'keep_global',
        customWidth: 832,
        customHeight: 1216,
        isDefault: true,
        isSystem: true
    },
    {
        id: 'preset_front_back',
        name: '人物正背面 (2段分镜)',
        contextScope: 'last_1',
        contextCount: 1,
        sourceCharCard: true,
        sourceLorebook: true,
        sourceUserPersona: false,
        extractPrompt: "You are a prompt generator. Based on the immediate context of {{char}}, generate 2 distinct shots: front view and back view.\nStrictly format your response with \"---DIVIDER---\" between shots.\n\nShot 1 (Front View tags):\nfront view, facing viewer, {{char}}, facial expression, front pose, outfit details, lighting\n\n---DIVIDER---\n\nShot 2 (Back View tags):\nfrom behind, back view, {{char}} looking back, hair from behind, back of outfit, detailed background\n\nRequirements: Output ONLY Danbooru tags, separated by commas. Do NOT output conversational text.",
        shotCount: 2,
        resolution: '1024x1536',
        customWidth: 1024,
        customHeight: 1536,
        isDefault: false,
        isSystem: false
    },
    {
        id: 'preset_face_close_up',
        name: '面部与表情特写',
        contextScope: 'last_1',
        contextCount: 1,
        sourceCharCard: true,
        sourceLorebook: false,
        sourceUserPersona: false,
        extractPrompt: "Focus exclusively on {{char}}'s face and micro-expression based on the immediate context.\nOutput format: close-up, face focus, portrait, [hair features], [eye details & gaze direction], [detailed expression: blushing/smiling/shocked/pouting], soft cinematic facial lighting, masterpiece, highres.\nOutput ONLY English comma-separated tags.",
        shotCount: 1,
        resolution: '1024x1024',
        customWidth: 1024,
        customHeight: 1024,
        isDefault: false,
        isSystem: false
    },
    {
        id: 'preset_scene_background',
        name: '场景环境背景 (无人物)',
        contextScope: 'recent_n',
        contextCount: 3,
        sourceCharCard: false,
        sourceLorebook: true,
        sourceUserPersona: false,
        extractPrompt: "Extract the physical environment, architecture, room details, weather, and lighting of the current location without characters.\nOutput format: scenery, no humans, landscape, architectural details, atmospheric lighting, depth of field, detailed background.\nOutput ONLY English comma-separated tags.",
        shotCount: 1,
        resolution: '1216x832',
        customWidth: 1216,
        customHeight: 832,
        isDefault: false,
        isSystem: false
    }
];

const defaultSettings = {
    serverUrl: 'http://127.0.0.1:8188',
    connectionMode: 'auto',
    workflowJson: null,
    workflowFilename: '',
    promptNodeId: '',
    negativeNodeId: '',
    negativeStrategy: 'keep_workflow',
    latentNodeId: '',
    outputNodeId: '',
    seedNodeIds: [],
    seedStrategy: 'random',
    fixedSeed: 123456,
    lastUsedSeed: null,
    charTagRegex: '\\[SD_TAG:\\s*([^\\]]+)\\]',
    globalPrefix: 'masterpiece, best quality, ultra-detailed',
    globalNegative: 'worst quality, low quality, bad anatomy, bad hands, missing fingers, deformed, blurry',
    extractSystemPrompt: 'You are a Stable Diffusion prompt generator. Read the recent roleplay conversation context and extract the character\'s current action, pose, facial expression, clothing condition, environment, lighting, and mood.\nOutput requirements:\n1. Output ONLY English Danbooru-style comma-separated tags.\n2. Do not repeat fixed character traits (e.g. hair/eye color) as they are handled globally.\n3. Output NO conversational words, NO explanations, ONLY tags.\nExample output: sitting by window, holding tea cup, gentle smile, sunset lighting, indoor, cozy room',
    contextCount: 3,
    resolutionMode: 'keep_workflow',
    defaultResolution: 'keep_workflow',
    customWidth: 832,
    customHeight: 1216,
    autoGenerate: false,
    showMessageButton: true,
    showPreviewDialog: true,
    // 预设系统集合与激活指针
    presets: JSON.parse(JSON.stringify(BUILTIN_PRESETS)),
    activePresetId: 'preset_default',
    editingPresetId: 'preset_default',
};

let settings = {};

/**
 * 加载并合并设置，确保 presets 数组有效且包含默认系统项
 */
function loadSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    settings = Object.assign({}, defaultSettings, extension_settings[MODULE_NAME]);

    if (!Array.isArray(settings.presets) || settings.presets.length === 0) {
        settings.presets = JSON.parse(JSON.stringify(BUILTIN_PRESETS));
    } else {
        // 保证系统默认预设 preset_default 始终存在且不可删除
        const hasDefault = settings.presets.some(p => p.id === 'preset_default');
        if (!hasDefault) {
            settings.presets.unshift(JSON.parse(JSON.stringify(BUILTIN_PRESETS[0])));
        }
    }

    if (!settings.activePresetId || !settings.presets.some(p => p.id === settings.activePresetId)) {
        settings.activePresetId = settings.presets[0].id;
    }
    if (!settings.editingPresetId || !settings.presets.some(p => p.id === settings.editingPresetId)) {
        settings.editingPresetId = settings.activePresetId;
    }

    extension_settings[MODULE_NAME] = settings;
}

/**
 * 持久化设置
 */
function saveSettings() {
    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();
}

/**
 * 测试 ComfyUI 连接状态（支持 CORS 智能诊断与引导）
 */
async function testComfyConnection(showToast = true) {
    const badgeDot = $('#comfy_status_dot');
    const badgeText = $('#comfy_status_text');
    const corsBox = $('#comfy_cors_help_box');

    badgeDot.removeClass('online offline').addClass('checking');
    badgeText.text('检测中...');

    try {
        const url = settings.serverUrl.replace(/\/+$/, '');
        const res = await fetch(`${url}/system_stats`, { 
            method: 'GET',
            mode: 'cors',
            cache: 'no-cache'
        });

        if (res.ok) {
            const data = await res.json();
            badgeDot.removeClass('checking offline').addClass('online');
            badgeText.text('在线');
            corsBox.slideUp(200);

            if (showToast) {
                const gpuInfo = data?.devices?.[0]?.name ? ` (${data.devices[0].name})` : '';
                toastr.success(`ComfyUI 握手成功！${gpuInfo}`, 'ComfyUI 连接正常');
            }
            return true;
        } else {
            throw new Error(`HTTP 状态码: ${res.status}`);
        }
    } catch (e) {
        badgeDot.removeClass('checking online').addClass('offline');
        badgeText.text('离线');

        const errStr = String(e?.message || e);
        const isCorsOrFetchFailed = errStr.includes('Failed to fetch') || errStr.includes('NetworkError');

        if (isCorsOrFetchFailed) {
            corsBox.slideDown(250);
            if (showToast) {
                toastr.error('无法连接到 ComfyUI: 浏览器跨域策略阻断 (Failed to fetch)。请参见下方提示开启 --enable-cors-header *', '跨域阻断提示', { timeOut: 8000 });
            }
        } else {
            if (showToast) {
                toastr.error(`连接 ComfyUI 异常: ${errStr}`, '连接失败');
            }
        }
        return false;
    }
}

/**
 * 广义分析工作流中的候选接口节点
 */
function inspectWorkflow(workflow) {
    if (!workflow || typeof workflow !== 'object') return null;

    const textNodes = [];
    const latentNodes = [];
    const seedNodes = [];
    const outputNodes = [];

    for (const [id, node] of Object.entries(workflow)) {
        if (!node || typeof node !== 'object') continue;
        const inputs = node.inputs || {};
        const title = node._meta?.title || node.class_type || `Node #${id}`;
        const classType = String(node.class_type || '');

        // 1. 文本提示词节点 (匹配 text, prompt, string, text_positive, text_negative 等)
        for (const [key, val] of Object.entries(inputs)) {
            if (typeof val === 'string' && (key === 'text' || key === 'prompt' || key === 'string' || key === 'value')) {
                textNodes.push({ id, field: key, title, class_type: classType, value: val });
                break;
            }
        }

        // 2. Latent 分辨率节点 (包含 width 和 height)
        if (typeof inputs.width === 'number' && typeof inputs.height === 'number') {
            latentNodes.push({ 
                id, 
                title, 
                class_type: classType, 
                width: inputs.width, 
                height: inputs.height 
            });
        }

        // 3. 采样器与种子节点 (包含 seed 或 noise_seed)
        if ('seed' in inputs || 'noise_seed' in inputs) {
            seedNodes.push({ id, title, class_type: classType });
        }

        // 4. 图像输出节点 (SaveImage, PreviewImage 等)
        if (classType.includes('SaveImage') || classType.includes('PreviewImage') || 'images' in inputs) {
            outputNodes.push({ 
                id, 
                title, 
                class_type: classType, 
                isSaveImage: classType.includes('SaveImage') 
            });
        }
    }

    return { textNodes, latentNodes, seedNodes, outputNodes };
}

/**
 * 根据工作流结构填充设置面板中的下拉框
 */
function updateMappingDropdowns(workflow) {
    const promptSelect = $('#comfy_map_prompt_node');
    const negSelect = $('#comfy_map_neg_prompt_node');
    const latentSelect = $('#comfy_map_latent_node');
    const outputSelect = $('#comfy_map_output_node');
    const seedContainer = $('#comfy_seed_nodes_container');

    promptSelect.empty();
    negSelect.empty();
    latentSelect.empty();
    outputSelect.empty();
    seedContainer.empty();

    if (!workflow) {
        promptSelect.append('<option value="">-- 请先上传工作流 API JSON --</option>');
        negSelect.append('<option value="">-- 不修改 / 保持原样 --</option>');
        latentSelect.append('<option value="">-- 请先上传工作流 API JSON --</option>');
        outputSelect.append('<option value="">-- 自动捕获首个输出图像 --</option>');
        seedContainer.html('<div class="comfy-empty-hint">暂无工作流节点</div>');
        return;
    }

    const inspection = inspectWorkflow(workflow);
    if (!inspection) return;

    // 1. 正向提示词
    promptSelect.append('<option value="">-- 请选择正向提示词节点 --</option>');
    inspection.textNodes.forEach(node => {
        const selected = String(node.id) === String(settings.promptNodeId) ? 'selected' : '';
        promptSelect.append(`<option value="${node.id}" ${selected}>[#${node.id}] ${node.title} (${node.class_type})</option>`);
    });

    // 2. 负向提示词
    negSelect.append('<option value="">-- 不修改 / 保持工作流原样 --</option>');
    inspection.textNodes.forEach(node => {
        const selected = String(node.id) === String(settings.negativeNodeId) ? 'selected' : '';
        negSelect.append(`<option value="${node.id}" ${selected}>[#${node.id}] ${node.title} (${node.class_type})</option>`);
    });

    // 3. 分辨率节点
    latentSelect.append('<option value="">-- 请选择 Latent 分辨率节点 --</option>');
    inspection.latentNodes.forEach(node => {
        const selected = String(node.id) === String(settings.latentNodeId) ? 'selected' : '';
        latentSelect.append(`<option value="${node.id}" ${selected}>[#${node.id}] ${node.title} (${node.width}×${node.height})</option>`);
    });

    // 4. 输出图片节点
    outputSelect.append('<option value="">-- 自动捕获 SaveImage 成品图 --</option>');
    inspection.outputNodes.forEach(node => {
        const selected = String(node.id) === String(settings.outputNodeId) ? 'selected' : '';
        const tag = node.isSaveImage ? ' [推荐:最终保存]' : '';
        outputSelect.append(`<option value="${node.id}" ${selected}>[#${node.id}] ${node.title}${tag}</option>`);
    });

    // 5. 种子节点列表
    if (inspection.seedNodes.length === 0) {
        seedContainer.html('<div class="comfy-empty-hint">未扫描到带 seed/noise_seed 的采样节点</div>');
    } else {
        inspection.seedNodes.forEach(node => {
            const isChecked = settings.seedNodeIds.map(String).includes(String(node.id)) ? 'checked' : '';
            const itemHtml = `
                <label class="comfy-seed-checkbox-label">
                    <input type="checkbox" class="comfy-seed-checkbox" value="${node.id}" ${isChecked}>
                    <span>[#${node.id}] ${node.title}</span>
                </label>
            `;
            seedContainer.append(itemHtml);
        });
    }

    // 更新元信息展示
    if (settings.workflowFilename) {
        $('#comfy_workflow_meta').show();
        $('#comfy_workflow_filename').text(settings.workflowFilename);
        $('#comfy_workflow_nodes_count').text(`${Object.keys(workflow).length} 个节点`);
    }
}

/**
 * 智能猜测并自动绑定接口节点
 */
function autoMatchWorkflowInterfaces(workflow) {
    const inspection = inspectWorkflow(workflow);
    if (!inspection) return;

    // 1. 正向词
    const positiveCandidate = inspection.textNodes.find(n => {
        const str = `${n.title} ${n.class_type}`.toLowerCase();
        return (str.includes('pos') || str.includes('prompt') || str.includes('正向')) &&
               !str.includes('neg') && !str.includes('负向');
    }) || inspection.textNodes[0];

    if (positiveCandidate) {
        settings.promptNodeId = positiveCandidate.id;
        $('#comfy_map_prompt_node').val(positiveCandidate.id);
    }

    // 2. 负向词
    const negativeCandidate = inspection.textNodes.find(n => {
        const str = `${n.title} ${n.class_type}`.toLowerCase();
        return str.includes('neg') || str.includes('负向');
    });

    if (negativeCandidate) {
        settings.negativeNodeId = negativeCandidate.id;
        $('#comfy_map_neg_prompt_node').val(negativeCandidate.id);
    }

    // 3. 分辨率
    const latentCandidate = inspection.latentNodes.find(n => {
        const str = `${n.title} ${n.class_type}`.toLowerCase();
        return str.includes('empty') || str.includes('latent');
    }) || inspection.latentNodes[0];

    if (latentCandidate) {
        settings.latentNodeId = latentCandidate.id;
        $('#comfy_map_latent_node').val(latentCandidate.id);
    }

    // 4. 最终输出图片节点 (优先 SaveImage)
    const saveCandidate = inspection.outputNodes.find(n => n.isSaveImage) || inspection.outputNodes[0];
    if (saveCandidate) {
        settings.outputNodeId = saveCandidate.id;
        $('#comfy_map_output_node').val(saveCandidate.id);
    }

    // 5. 种子全部同步
    settings.seedNodeIds = inspection.seedNodes.map(n => n.id);
    $('.comfy-seed-checkbox').prop('checked', true);

    saveSettings();
    toastr.info('已自动分析并推荐接口映射！请检查各节点是否符合预期。', '智能匹配完成');
}

/**
 * 导出映射配置文件 mapping_config.json
 */
function exportMappingConfig() {
    const config = {
        name: 'comfyui_drawer_mapping',
        version: '2.0',
        exportedAt: new Date().toISOString(),
        workflowFilename: settings.workflowFilename || '',
        mapping: {
            promptNodeId: settings.promptNodeId,
            negativeNodeId: settings.negativeNodeId,
            negativeStrategy: settings.negativeStrategy,
            latentNodeId: settings.latentNodeId,
            outputNodeId: settings.outputNodeId,
            seedNodeIds: settings.seedNodeIds,
            seedStrategy: settings.seedStrategy,
            resolutionMode: settings.resolutionMode,
            defaultResolution: settings.defaultResolution,
            customWidth: settings.customWidth,
            customHeight: settings.customHeight
        }
    };

    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `comfy_mapping_${settings.workflowFilename.replace(/\.json$/i, '') || 'default'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toastr.success('已成功导出工作流映射配置文件！', '导出成功');
}

/**
 * 导入映射配置文件 mapping_config.json
 */
function importMappingConfig(jsonContent) {
    try {
        const parsed = JSON.parse(jsonContent);
        const map = parsed.mapping || parsed;

        if (map.promptNodeId !== undefined) settings.promptNodeId = map.promptNodeId;
        if (map.negativeNodeId !== undefined) settings.negativeNodeId = map.negativeNodeId;
        if (map.negativeStrategy !== undefined) settings.negativeStrategy = map.negativeStrategy;
        if (map.latentNodeId !== undefined) settings.latentNodeId = map.latentNodeId;
        if (map.outputNodeId !== undefined) settings.outputNodeId = map.outputNodeId;
        if (Array.isArray(map.seedNodeIds)) settings.seedNodeIds = map.seedNodeIds;
        if (map.seedStrategy !== undefined) settings.seedStrategy = map.seedStrategy;
        if (map.defaultResolution !== undefined) settings.defaultResolution = map.defaultResolution;
        if (map.customWidth !== undefined) settings.customWidth = map.customWidth;
        if (map.customHeight !== undefined) settings.customHeight = map.customHeight;

        saveSettings();

        // 刷新 UI 状态
        if (settings.workflowJson) {
            updateMappingDropdowns(settings.workflowJson);
        }
        $('#comfy_override_negative').val(settings.negativeStrategy);
        $('#comfy_default_resolution').val(settings.defaultResolution);
        $('#comfy_seed_mode').val(settings.seedStrategy);
        $('#comfy_fixed_seed_val').val(settings.fixedSeed);
        $('#comfy_custom_width').val(settings.customWidth);
        $('#comfy_custom_height').val(settings.customHeight);

        $('#comfy_custom_resolution_row').toggle(settings.defaultResolution === 'custom');
        $('#comfy_fixed_seed_row').toggle(settings.seedStrategy === 'fixed');

        toastr.success('工作流映射配置已成功导入并应用！', '导入成功');
    } catch (e) {
        toastr.error(`导入配置文件失败: ${e.message}`, '格式错误');
    }
}

/**
 * 从角色卡中提取固定外观标签
 */
function getCharacterFixedTags() {
    try {
        const context = getContext();
        const char = context.characters?.[this_chid];
        if (!char) return '';

        const searchCorpus = [
            char.description,
            char.personality,
            char.scenario,
            char.creator_notes,
            JSON.stringify(char.data?.character_book || {})
        ].filter(Boolean).join('\n');

        const regex = new RegExp(settings.charTagRegex, 'i');
        const match = searchCorpus.match(regex);
        if (match && match[1]) {
            return match[1].trim();
        }
    } catch (e) {
        console.warn('[ComfyUI Drawer] 提取角色卡特征标签异常:', e);
    }
    return '';
}

/**
 * 清洗大模型输出（剔除思考链、代码块、台词对话与多余说明）
 */
function cleanLlmPromptResponse(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let text = raw;

    // 1. 清洗 <think> ... </think> 思考链
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    text = text.replace(/<thought>[\s\S]*?<\/thought>/gi, '');

    // 2. 清洗 markdown 代码块
    text = text.replace(/```[a-z]*\n?[\s\S]*?```/gi, '');
    text = text.replace(/```/g, '');

    // 3. 清洗常见引导语 (如 Prompt 1:, Tags:, Shot 1:)
    text = text.replace(/^(Tags|Prompt|Keywords|SD_Tags|Output|Shot\s*\d+):\s*/i, '');
    text = text.replace(/(\n|^)[A-Za-z0-9_\-\s]+:\s*/g, ' ');

    // 4. 清理首尾与多余逗号换行
    text = text.replace(/\r?\n+/g, ', ');
    text = text.replace(/,\s*,+/g, ',');
    text = text.replace(/^[, ]+|[, ]+$/g, '');

    return text.trim();
}

/**
 * 将 LLM 生成的原始结果切分为多段分镜提示词
 */
function splitMultiShotPrompts(rawLlmOutput, expectedCount = 1) {
    if (!rawLlmOutput || typeof rawLlmOutput !== 'string') {
        return [''];
    }

    // 先剔除思考链和代码块
    let text = rawLlmOutput.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<thought>[\s\S]*?<\/thought>/gi, '');
    text = text.replace(/```[a-z]*\n?[\s\S]*?```/gi, '').replace(/```/g, '').trim();

    if (expectedCount <= 1) {
        return [cleanLlmPromptResponse(text)];
    }

    // 1. 尝试使用专属分隔标记 ---DIVIDER--- 或横线分隔
    let sections = [];
    if (text.includes('---DIVIDER---')) {
        sections = text.split('---DIVIDER---');
    } else if (/^-{3,}$/m.test(text)) {
        sections = text.split(/^-{3,}$/m);
    } else if (/^={3,}$/m.test(text)) {
        sections = text.split(/^={3,}$/m);
    } else if (/(\n|^)(?:分镜|镜头|段落|Shot|Prompt)\s*(?:\d+|一|二|三|四)[\s:：]/i.test(text)) {
        // 匹配 "分镜1:" 或 "Shot 1:"
        sections = text.split(/(?:\n|^)(?:分镜|镜头|段落|Shot|Prompt)\s*(?:\d+|一|二|三|四)[\s:：]/i);
    } else if (text.includes('\n\n')) {
        sections = text.split(/\n\s*\n/);
    }

    const cleaned = sections
        .map(s => cleanLlmPromptResponse(s))
        .filter(s => s && s.length > 5);

    if (cleaned.length >= expectedCount) {
        return cleaned.slice(0, expectedCount);
    } else if (cleaned.length > 0) {
        return cleaned;
    }

    return [cleanLlmPromptResponse(text)];
}

/**
 * 多源上下文聚合器：提取对话切片并注入角色卡、世界书与用户设定
 */
async function gatherContextData(preset, targetMessageId = null) {
    const context = getContext();
    const chat = context.chat || [];
    const char = context.characters?.[this_chid];
    const charName = context.name2 || char?.name || 'Character';
    const userName = context.name1 || 'User';

    const promptBlocks = [];

    // 1. 宏变量替换提词规则模板
    let instruction = preset.extractPrompt || settings.extractSystemPrompt;
    instruction = instruction
        .replace(/\{\{char\}\}/gi, charName)
        .replace(/\{\{user\}\}/gi, userName)
        .replace(/\{\{count\}\}/gi, String(preset.shotCount || 1));

    promptBlocks.push(instruction);

    // 2. 注入角色卡外貌与设定 (如果勾选)
    if (preset.sourceCharCard && char) {
        const charCorpus = [
            char.description ? `[Appearance & Description]:\n${char.description}` : '',
            char.personality ? `[Personality]:\n${char.personality}` : '',
            char.scenario ? `[Current Scenario]:\n${char.scenario}` : ''
        ].filter(Boolean).join('\n\n');

        if (charCorpus.trim()) {
            promptBlocks.push(`--- Character Profile (${charName}) ---\n${charCorpus}`);
        }
    }

    // 3. 注入世界书/Lorebook (如果勾选)
    if (preset.sourceLorebook && char?.data?.character_book?.entries) {
        try {
            const entries = char.data.character_book.entries
                .filter(e => e.enabled !== false && e.content)
                .slice(0, 5) // 截取前 5 条避免上下文超载
                .map(e => `[${e.comment || e.keys?.join('/') || 'Entry'}]: ${e.content}`)
                .join('\n');
            if (entries.trim()) {
                promptBlocks.push(`--- World & Lorebook Information ---\n${entries}`);
            }
        } catch (err) {
            console.warn('[ComfyUI Drawer] 提取世界书词条忽略:', err);
        }
    }

    // 4. 注入用户人设 (如果勾选)
    if (preset.sourceUserPersona) {
        try {
            let userPersona = '';
            if (typeof power_user !== 'undefined') {
                userPersona = power_user.persona_description || power_user.persona_descriptions?.[power_user.current_persona]?.description || '';
            }
            if (!userPersona && context.user_persona) {
                userPersona = String(context.user_persona);
            }
            if (userPersona.trim()) {
                promptBlocks.push(`--- User Persona (${userName}) ---\n${userPersona.trim()}`);
            }
        } catch (err) {
            console.warn('[ComfyUI Drawer] 提取用户设定忽略:', err);
        }
    }

    // 5. 对话内容切片 (根据 contextScope 决定)
    if (preset.contextScope !== 'none' && chat.length > 0) {
        let endIndex = chat.length - 1;
        if (targetMessageId !== null) {
            const foundIndex = chat.findIndex(m => String(m.id) === String(targetMessageId) || chat.indexOf(m) === Number(targetMessageId));
            if (foundIndex !== -1) endIndex = foundIndex;
        }

        let startIndex = 0;
        if (preset.contextScope === 'last_1') {
            startIndex = endIndex;
        } else if (preset.contextScope === 'all') {
            startIndex = Math.max(0, endIndex - 25); // 最多 25 条历史防爆窗
        } else {
            // recent_n
            const count = Math.max(1, Number(preset.contextCount) || Number(settings.contextCount) || 3);
            startIndex = Math.max(0, endIndex - count + 1);
        }

        const slice = chat.slice(startIndex, endIndex + 1);
        const dialogText = slice
            .map(m => {
                const sender = m.name || (m.is_user ? userName : charName);
                // 剔除 markdown 图片与 HTML 标签，防止之前生成的 Base64 塞爆 LLM 上下文
                const cleanText = (m.mes || '')
                    .replace(/!\[.*?\]\(.*?\)/gs, '')
                    .replace(/<img[^>]*>/gi, '')
                    .trim();
                return `${sender}: ${cleanText}`;
            })
            .filter(line => line.includes(':') && line.split(':')[1].trim().length > 0)
            .join('\n');

        if (dialogText.trim()) {
            promptBlocks.push(`--- Relevant Conversation Context ---\n${dialogText}`);
        }
    }

    promptBlocks.push('\n[Generated Tags Output]:');
    return promptBlocks.join('\n\n');
}

/**
 * 根据预设调用大模型提取场景 Tags 数组（支持 1~4 段分镜）
 */
async function generatePresetSceneTags(preset, targetMessageId = null) {
    try {
        const fullInstruction = await gatherContextData(preset, targetMessageId);
        const shotCount = Math.max(1, Number(preset.shotCount) || 1);

        toastr.info(`大模型正在根据「${preset.name}」提取提示词 (${shotCount}段)...`, 'ComfyUI 提示词生成', { timeOut: 2500 });
        
        // 使用对象参数调用 generateQuietPrompt，兼容新版酒馆并防止旧版API传递异常
        const rawResult = await generateQuietPrompt({
            quietPrompt: fullInstruction,
            quietToLoud: false,
            skipWIAN: false,
            removeReasoning: true
        });

        console.log('[ComfyUI Drawer] 大模型原始返回内容:', rawResult);
        const tagsArray = splitMultiShotPrompts(rawResult, shotCount);
        console.log('[ComfyUI Drawer] 分割后的分镜提示词数组:', tagsArray);
        return tagsArray;
    } catch (e) {
        console.error('[ComfyUI Drawer] 大模型提取提示词异常:', e);
        toastr.warning(`提示词提取异常: ${e.message || e}，已采用默认标签`, '提示词提取');
        return ['1girl, solo, highres, masterpiece'];
    }
}

/**
 * 组装最终正向提示词（去重与逗号规范化）
 */
function assembleFinalPrompt(dynamicTags, preset = null) {
    // 若预设明确关闭角色卡参考 (如纯背景预设)，则不附加固定角色 SD_TAG
    const shouldAddCharTags = preset ? preset.sourceCharCard !== false : true;
    const fixedCharTags = shouldAddCharTags ? getCharacterFixedTags() : '';

    const parts = [
        settings.globalPrefix,
        fixedCharTags,
        dynamicTags
    ].filter(p => p && p.trim().length > 0);

    const merged = parts.join(', ');
    const tagList = merged.split(',').map(t => t.trim()).filter(Boolean);
    const seen = new Set();
    const deduplicated = [];

    for (const tag of tagList) {
        const lower = tag.toLowerCase();
        if (!seen.has(lower)) {
            seen.add(lower);
            deduplicated.push(tag);
        }
    }

    return deduplicated.join(', ');
}

/**
 * 计算当前出图使用的种子
 */
function calculateExecutionSeed() {
    const strategy = settings.seedStrategy || 'random';
    if (strategy === 'fixed') {
        return Number(settings.fixedSeed) || 123456;
    }
    if (strategy === 'reuse_last' && settings.lastUsedSeed !== null && settings.lastUsedSeed !== undefined) {
        return Number(settings.lastUsedSeed);
    }
    return Math.floor(Math.random() * 10000000000);
}

/**
 * 向 ComfyUI 发起生图任务并获取最终结果（支持预设分辨率覆盖）
 */
async function executeComfyWorkflow(positivePrompt, overrideResolution = null, customW = null, customH = null) {
    if (!settings.workflowJson) {
        throw new Error('尚未上传 ComfyUI 工作流 API JSON！请在设置面板上传。');
    }
    if (!settings.promptNodeId) {
        throw new Error('未配置正向提示词目标节点！请在设置面板中选择。');
    }

    const workflow = JSON.parse(JSON.stringify(settings.workflowJson));
    const currentSeed = calculateExecutionSeed();
    settings.lastUsedSeed = currentSeed;

    // 1. 注入正向提示词
    const promptNode = workflow[settings.promptNodeId];
    if (promptNode?.inputs) {
        const textKey = Object.keys(promptNode.inputs).find(k => typeof promptNode.inputs[k] === 'string') || 'text';
        promptNode.inputs[textKey] = positivePrompt;
    }

    // 2. 负向提示词策略分支处理
    if (settings.negativeNodeId && workflow[settings.negativeNodeId]?.inputs) {
        const negNode = workflow[settings.negativeNodeId];
        const negKey = Object.keys(negNode.inputs).find(k => typeof negNode.inputs[k] === 'string') || 'text';
        const originalNeg = negNode.inputs[negKey] || '';

        if (settings.negativeStrategy === 'override_global') {
            negNode.inputs[negKey] = settings.globalNegative || '';
        } else if (settings.negativeStrategy === 'append_global') {
            const combined = [originalNeg, settings.globalNegative].filter(Boolean).join(', ');
            negNode.inputs[negKey] = combined;
        }
    }

    // 3. 分辨率策略分支处理（优先使用预设指定的 overrideResolution，次之全局配置）
    if (settings.latentNodeId && workflow[settings.latentNodeId]?.inputs) {
        const latentNode = workflow[settings.latentNodeId];
        const resChoice = (overrideResolution && overrideResolution !== 'keep_global') ? overrideResolution : settings.defaultResolution;

        if (resChoice === 'custom') {
            const w = Number(customW) || Number(settings.customWidth) || 832;
            const h = Number(customH) || Number(settings.customHeight) || 1216;
            latentNode.inputs.width = w;
            latentNode.inputs.height = h;
        } else if (resChoice !== 'keep_workflow' && resChoice) {
            const [w, h] = resChoice.split('x').map(Number);
            if (w && h) {
                latentNode.inputs.width = w;
                latentNode.inputs.height = h;
            }
        }
    }

    // 4. 同步种子到所有被勾选的采样器节点
    if (Array.isArray(settings.seedNodeIds)) {
        settings.seedNodeIds.forEach(nodeId => {
            const node = workflow[nodeId];
            if (node?.inputs) {
                if ('seed' in node.inputs) node.inputs.seed = currentSeed;
                if ('noise_seed' in node.inputs) node.inputs.noise_seed = currentSeed;
            }
        });
    }

    const serverUrl = settings.serverUrl.replace(/\/+$/, '');
    const clientId = crypto.randomUUID();

    // 5. 提交任务到 ComfyUI 队列
    let res;
    try {
        res = await fetch(`${serverUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: workflow, client_id: clientId })
        });
    } catch (fetchErr) {
        if (String(fetchErr).includes('Failed to fetch')) {
            $('#comfy_cors_help_box').slideDown(250);
            throw new Error('连接 ComfyUI 失败 (Failed to fetch)。ComfyUI 默认开启了跨域限制，请为 ComfyUI 添加启动参数 `--enable-cors-header *`');
        }
        throw fetchErr;
    }

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`ComfyUI 拒绝请求 (${res.status}): ${errorText}`);
    }

    const { prompt_id } = await res.json();
    if (!prompt_id) throw new Error('未能从 ComfyUI 获得有效任务编号 (prompt_id)');

    // 6. 轮询结果 (最长等待 180 秒)
    const startTime = Date.now();
    let imageInfo = null;

    while (Date.now() - startTime < 180000) {
        await new Promise(r => setTimeout(r, 1200));
        let historyRes;
        try {
            historyRes = await fetch(`${serverUrl}/history/${prompt_id}`);
        } catch (e) {
            continue;
        }
        if (!historyRes.ok) continue;

        const historyData = await historyRes.json();
        const outputs = historyData[prompt_id]?.outputs;

        if (outputs) {
            // 优先检查用户指定的 outputNodeId
            if (settings.outputNodeId && outputs[settings.outputNodeId]?.images?.length > 0) {
                imageInfo = outputs[settings.outputNodeId].images[0];
                break;
            }

            // 其次按优先级挑选：忽略 PreviewImage，优先寻找 SaveImage 节点
            const candidateNodeIds = Object.keys(outputs);
            for (const nodeId of candidateNodeIds) {
                const nodeImages = outputs[nodeId]?.images;
                if (Array.isArray(nodeImages) && nodeImages.length > 0) {
                    const nodeMeta = workflow[nodeId];
                    const classType = String(nodeMeta?.class_type || '');
                    if (classType.includes('SaveImage')) {
                        imageInfo = nodeImages[0];
                        break;
                    }
                }
            }

            // 兜底：若无明确 SaveImage 则取第一个有效图片
            if (!imageInfo) {
                for (const nodeId of candidateNodeIds) {
                    const nodeImages = outputs[nodeId]?.images;
                    if (Array.isArray(nodeImages) && nodeImages.length > 0) {
                        imageInfo = nodeImages[0];
                        break;
                    }
                }
            }

            if (imageInfo) break;
        }
    }

    if (!imageInfo) {
        throw new Error('生图任务超时（超过 180 秒未返回成品图），请检查 ComfyUI 控制台是否报错！');
    }

    // 7. 读取最终图片并转为 Base64
    const viewUrl = `${serverUrl}/view?filename=${encodeURIComponent(imageInfo.filename)}&subfolder=${encodeURIComponent(imageInfo.subfolder || '')}&type=${encodeURIComponent(imageInfo.type || 'output')}`;
    const imgBlob = await (await fetch(viewUrl)).blob();

    const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(imgBlob);
    });

    return {
        base64,
        seed: currentSeed,
        filename: imageInfo.filename
    };
}

/**
 * 将生成的多张/单张图片以画廊或单卡形式插入到酒馆消息中
 */
async function attachGalleryToChatMessage(targetMessageId, results, presetName = '') {
    if (!Array.isArray(results) || results.length === 0) return;

    const context = getContext();
    const chat = context.chat || [];
    let targetMsg = null;

    if (targetMessageId !== null) {
        targetMsg = chat[targetMessageId] || chat.find(m => String(m.id) === String(targetMessageId));
    }
    if (!targetMsg) {
        targetMsg = chat[chat.length - 1];
    }

    if (!targetMsg) {
        toastr.error('当前无可用对话消息可追加图片！');
        return;
    }

    // 1. 尝试将 Base64 图片保存为 SillyTavern 本地文件，防止聊天记录文件急剧膨胀
    const savedUrls = [];
    for (let i = 0; i < results.length; i++) {
        const item = results[i];
        let url = item.base64;
        try {
            if (item.base64 && typeof item.base64 === 'string' && item.base64.startsWith('data:image/')) {
                const rawData = item.base64.replace(/^data:image\/\w+;base64,/, '');
                const filename = `comfy_${Date.now()}_${i}_${item.seed || 'seed'}`;
                const savedPath = await saveBase64AsFile(rawData, 'sim-comfy2st', filename, 'png');
                if (savedPath) {
                    url = savedPath;
                }
            }
        } catch (err) {
            console.warn('[ComfyUI Drawer] 转存本地文件失败，降级使用 Base64:', err);
        }
        savedUrls.push(url);
    }

    // 2. 追加 Markdown 格式图片确保持久化存储到聊天记录中（仅允许合法文件短路径，严禁将 Base64 写入 mes）
    const mdImages = savedUrls
        .filter(url => url && typeof url === 'string' && !url.startsWith('data:image/'))
        .map((url, idx) => `\n![${presetName || 'ComfyUI'} 分镜${idx + 1}](${url})`)
        .join('');
    if (mdImages) {
        targetMsg.mes = (targetMsg.mes || '') + '\n' + mdImages + '\n';
    }

    // 3. 动态渲染 DOM 卡片
    const msgIndex = chat.indexOf(targetMsg);
    const msgElement = $(`#chat .mes[mesid="${msgIndex}"]`);
    if (msgElement.length) {
        const mesTextContainer = msgElement.find('.mes_text');
        
        let galleryHtml = '';
        if (results.length === 1) {
            const item = results[0];
            const displaySrc = savedUrls[0] || item.base64;
            galleryHtml = `
                <div class="comfy-chat-image-wrapper">
                    <div class="comfy-chat-image-card">
                        <img src="${displaySrc}" alt="ComfyUI 图片" title="点击查看大图 (Seed: ${item.seed})" />
                    </div>
                </div>
            `;
        } else {
            const cards = results.map((item, idx) => {
                const displaySrc = savedUrls[idx] || item.base64;
                return `
                    <div class="comfy-chat-image-card">
                        <span class="comfy-shot-badge">分镜 ${idx + 1}</span>
                        <img src="${displaySrc}" alt="分镜 ${idx + 1}" title="分镜 ${idx + 1} (Seed: ${item.seed})" />
                    </div>
                `;
            }).join('');

            galleryHtml = `
                <div class="comfy-chat-image-wrapper">
                    <div class="comfy-chat-gallery">
                        ${cards}
                    </div>
                </div>
            `;
        }
        mesTextContainer.append(galleryHtml);
    }

    await saveChatConditional();
    const seedsStr = results.map((r, i) => `#${i + 1}:${r.seed}`).join(', ');
    toastr.success(`「${presetName || 'ComfyUI'}」${results.length}张分镜图已全部生成并插入！(${seedsStr})`, '绘图完成');
}

/**
 * 兼容单张图片及快捷调用的图片追加函数 (修复 ReferenceError)
 */
async function attachImageToChatMessage(targetMessageId, result, title = 'ComfyUI 绘图') {
    if (!result) return;
    const results = Array.isArray(result) ? result : [result];
    await attachGalleryToChatMessage(targetMessageId, results, title);
}

/**
 * 弹出多段提示词预览与确认窗口
 */
async function promptConfirmationPopup(promptsList, preset) {
    let sizeDesc = '保持工作流原生';
    const resChoice = preset.resolution || settings.defaultResolution;
    if (resChoice === 'custom') {
        sizeDesc = `${preset.customWidth || settings.customWidth} × ${preset.customHeight || settings.customHeight}`;
    } else if (resChoice && resChoice !== 'keep_workflow' && resChoice !== 'keep_global') {
        sizeDesc = resChoice;
    }

    const promptInputs = promptsList.map((p, idx) => `
        <div style="margin-bottom: 8px;">
            <div style="font-weight: 600; font-size: 0.85rem; color: #38bdf8; margin-bottom: 3px;">
                分镜 ${idx + 1} (${idx + 1}/${promptsList.length})：
            </div>
            <textarea class="text_pole comfy-popup-prompt-item comfy-popup-prompt-area" data-index="${idx}" rows="${promptsList.length > 1 ? 3 : 5}">${p}</textarea>
        </div>
    `).join('');

    const popupHtml = `
        <div class="comfy-popup-container">
            <h4 style="margin:0 0 4px 0;"><i class="fa-solid fa-wand-magic-sparkles"></i> ComfyUI 预设生图确认 - ${preset.name}</h4>
            <div class="comfy-hint-text">
                已根据预设提取出以下 ${promptsList.length} 组提示词，确认后将依次提交 ComfyUI 队列生成：
            </div>
            <div style="max-height: 320px; overflow-y: auto; padding-right: 4px;">
                ${promptInputs}
            </div>
            <div class="flex-between" style="margin-top: 8px;">
                <span class="comfy-label">预设分辨率：<strong>${sizeDesc}</strong></span>
                <span class="comfy-label">生成张数：<strong>${promptsList.length} 张</strong></span>
            </div>
        </div>
    `;

    const popup = $(popupHtml);
    const confirmed = await callGenericPopup(popup, POPUP_TYPE.CONFIRM, '', {
        okButton: '立即批量出图',
        cancelButton: '取消',
        wide: true
    });

    if (confirmed) {
        const editedPrompts = [];
        popup.find('.comfy-popup-prompt-item').each(function () {
            editedPrompts.push($(this).val().trim());
        });
        return editedPrompts;
    }
    return null;
}

/**
 * 获取当前带有星标 ★ 的默认激活出图预设
 * 严格对应配置中的 settings.activePresetId，如不存在则安全降级到首个可用预设
 */
function getActiveStarPreset() {
    const presets = settings.presets || BUILTIN_PRESETS;
    const targetId = settings.activePresetId || 'preset_default';
    return presets.find(p => p.id === targetId) || presets[0] || BUILTIN_PRESETS[0];
}

/**
 * 根据指定预设执行完整生图流水线（支持单张/多段分镜批处理）
 * @param {string} presetId 预设ID
 * @param {number|null} targetMessageId 目标消息索引
 * @param {boolean} isAuto 是否为后台全自动生图（若为true，则跳过确认弹窗以确保自动流畅执行）
 */
async function triggerPresetGeneration(presetId, targetMessageId = null, isAuto = false) {
    const preset = settings.presets?.find(p => p.id === presetId) || getActiveStarPreset();
    if (!preset) {
        toastr.error('未找到指定的出图预设！');
        return;
    }

    try {
        // 1. 大模型提取多段场景 Tags
        const rawShotTags = await generatePresetSceneTags(preset, targetMessageId);
        
        // 2. 组装为完整的正向提示词数组
        let finalPrompts = rawShotTags.map(tag => assembleFinalPrompt(tag, preset));

        // 3. 若开启弹窗且不是全自动生图模式，则供用户核对微调
        if (settings.showPreviewDialog && !isAuto) {
            const userEdited = await promptConfirmationPopup(finalPrompts, preset);
            if (!userEdited) {
                toastr.info('已取消生图');
                return;
            }
            finalPrompts = userEdited;
        }

        // 4. 批处理队列依次提交 ComfyUI
        const totalCount = finalPrompts.length;
        const results = [];

        for (let i = 0; i < totalCount; i++) {
            const curPrompt = finalPrompts[i];
            toastr.info(`正在渲染分镜 (${i + 1}/${totalCount})...`, `ComfyUI 队列生成 [${preset.name}]`, { timeOut: 4000 });

            const res = await executeComfyWorkflow(
                curPrompt, 
                preset.resolution, 
                preset.customWidth, 
                preset.customHeight
            );
            results.push(res);
            // 给 ComfyUI 一点释放显存与准备时间
            if (i < totalCount - 1) {
                await new Promise(r => setTimeout(r, 600));
            }
        }

        // 5. 插入画廊或单卡到聊天框
        await attachGalleryToChatMessage(targetMessageId, results, preset.name);

    } catch (err) {
        console.error('[ComfyUI Drawer] 预设生图失败:', err);
        toastr.error(err.message || '未知异常', 'ComfyUI 绘图失败');
    }
}

/**
 * 消息按钮点击处理流程（触发当前星标默认激活预设）
 */
async function onDrawMessageClick(messageId, btnElement) {
    if (btnElement && btnElement.hasClass('loading')) return;
    if (btnElement) btnElement.addClass('loading');

    try {
        const starPreset = getActiveStarPreset();
        await triggerPresetGeneration(starPreset.id, messageId, false);
    } catch (e) {
        console.error('[ComfyUI Drawer] 消息出图失败:', e);
        toastr.error(e.message || '未知错误', 'ComfyUI 绘图失败');
    } finally {
        if (btnElement) btnElement.removeClass('loading');
    }
}

/**
 * 全自动生图调度管理（AI 回复完成后自动出图）
 * 严格调取当前星标默认预设，并具备完善的防重入、防并发锁保护
 */
let isAutoDrawing = false;
let lastAutoDrawnKey = null;

async function handleAutoGenerationForMessage(messageId) {
    if (!settings.autoGenerate) return;
    if (isAutoDrawing) return;

    const context = getContext();
    const chat = context.chat || [];
    if (!chat || chat.length === 0) return;

    const targetIndex = (messageId !== undefined && messageId !== null && !isNaN(messageId)) 
        ? Number(messageId) 
        : (chat.length - 1);

    const targetMsg = chat[targetIndex];
    if (!targetMsg || targetMsg.is_user || targetMsg.is_system) return;
    if (!targetMsg.mes || targetMsg.mes.trim() === '' || targetMsg.mes.trim() === '...') return;

    // 防止同一条消息重复触发自动出图
    const msgKey = `${context.chatId || 'default'}_${targetIndex}_${targetMsg.send_date || ''}`;
    if (lastAutoDrawnKey === msgKey || targetMsg._comfy_auto_drawn) {
        return;
    }

    isAutoDrawing = true;
    lastAutoDrawnKey = msgKey;
    targetMsg._comfy_auto_drawn = true;

    try {
        // 严格获取当前带有星标 ★ 的默认预设
        const starPreset = getActiveStarPreset();
        toastr.info(`检测到角色回复完毕，正在按照星标默认规则【${starPreset.name}】自动出图...`, 'ComfyUI 自动生图', { timeOut: 4500 });
        
        await triggerPresetGeneration(starPreset.id, targetIndex, true);
    } catch (err) {
        console.error('[ComfyUI Drawer] AI 回复自动生图执行失败:', err);
    } finally {
        isAutoDrawing = false;
    }
}

/**
 * ----------------------------------------------------
 * v2.2 升级：独立可拖拽、可缩放浮动窗口 (Floating Panel)
 * ----------------------------------------------------
 */

const FLOATING_PANEL_STORAGE_KEY = 'comfyui_drawer_panel_geometry';

/**
 * 获取上下文范围的友好中文名称
 */
function getScopeFriendlyName(scope) {
    switch (scope) {
        case 'none': return '纯角色外观';
        case 'last_1':
        case 'last_message': return '最近1条消息';
        case 'recent_n':
        case 'recent_5':
        case 'recent_10': return '最近N条对话';
        case 'all': return '全部对话历史';
        default: return '智能上下文';
    }
}

/**
 * 初始化并挂载浮动窗口 DOM 与事件交互
 */
function initComfyFloatingPanel() {
    let panel = $('#comfy_float_panel');
    if (panel.length > 0) return panel;

    panel = $(`
        <div id="comfy_float_panel" class="comfy-float-panel" style="display: none;">
            <div class="comfy-float-header" id="comfy_float_header">
                <div class="comfy-float-title">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>ComfyUI 场景预设</span>
                </div>
                <div class="comfy-float-controls">
                    <button class="comfy-float-btn" id="comfy_float_goto_settings" title="打开插件设置面板">
                        <i class="fa-solid fa-gear"></i>
                    </button>
                    <button class="comfy-float-btn close-btn" id="comfy_float_close_btn" title="关闭窗口 (ESC)">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
            <div class="comfy-float-body" id="comfy_float_body"></div>
            <div class="comfy-float-footer">
                <span class="comfy-float-manage-link" id="comfy_float_footer_manage">
                    <i class="fa-solid fa-sliders"></i> 自定义预设管理
                </span>
                <span class="comfy-float-resize-hint">
                    <i class="fa-solid fa-up-right-and-down-left-from-center"></i> 可拖动 / 可缩放
                </span>
            </div>
        </div>
    `);

    $('body').append(panel);

    // 恢复历史记忆位置与尺寸
    try {
        const savedGeo = JSON.parse(localStorage.getItem(FLOATING_PANEL_STORAGE_KEY) || '{}');
        if (savedGeo.left !== undefined && savedGeo.top !== undefined) {
            const clampedLeft = Math.max(10, Math.min(window.innerWidth - 120, savedGeo.left));
            const clampedTop = Math.max(10, Math.min(window.innerHeight - 80, savedGeo.top));
            panel.css({
                left: `${clampedLeft}px`,
                top: `${clampedTop}px`
            });
        } else {
            // 默认展示在屏幕右侧或左侧舒适区域
            const defaultLeft = Math.max(20, window.innerWidth - 420);
            const defaultTop = Math.max(60, Math.round(window.innerHeight * 0.18));
            panel.css({
                left: `${defaultLeft}px`,
                top: `${defaultTop}px`
            });
        }

        if (savedGeo.width && savedGeo.height) {
            panel.css({
                width: `${Math.max(300, Math.min(window.innerWidth * 0.9, savedGeo.width))}px`,
                height: `${Math.max(240, Math.min(window.innerHeight * 0.9, savedGeo.height))}px`
            });
        }
    } catch (e) {
        console.warn('[ComfyUI Drawer] 恢复浮动面板位置失败:', e);
    }

    // 绑定拖拽逻辑 (原生 Pointer Events，稳定且无依赖)
    const header = panel.find('#comfy_float_header')[0];
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    header.addEventListener('pointerdown', (e) => {
        if ($(e.target).closest('.comfy-float-btn').length > 0) return;
        isDragging = true;
        header.setPointerCapture(e.pointerId);
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        const rect = panel[0].getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        panel.addClass('active-window');
        e.preventDefault();
    });

    header.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const deltaX = e.clientX - dragStartX;
        const deltaY = e.clientY - dragStartY;
        const panelWidth = panel.outerWidth();
        const panelHeight = panel.outerHeight();

        let newLeft = initialLeft + deltaX;
        let newTop = initialTop + deltaY;

        // 视口边界保护
        newLeft = Math.max(8, Math.min(window.innerWidth - panelWidth - 8, newLeft));
        newTop = Math.max(8, Math.min(window.innerHeight - 50, newTop));

        panel.css({ left: `${newLeft}px`, top: `${newTop}px` });
    });

    const stopDragging = (e) => {
        if (!isDragging) return;
        isDragging = false;
        try {
            header.releasePointerCapture(e.pointerId);
        } catch (_) {}

        // 持久化保存几何位置
        saveFloatingPanelGeometry();
    };

    header.addEventListener('pointerup', stopDragging);
    header.addEventListener('pointercancel', stopDragging);

    // 缩放手柄监听 (当用户调整大小时记录持久化尺寸)
    if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => {
            if (panel.is(':visible')) {
                saveFloatingPanelGeometry();
            }
        });
        ro.observe(panel[0]);
    }

    // 控制栏按钮事件
    panel.on('click', '#comfy_float_close_btn', () => closeComfyFloatingPanel());
    panel.on('click', '#comfy_float_goto_settings, #comfy_float_footer_manage', (e) => {
        e.stopPropagation();
        $('#extensions_settings_button').trigger('click');
        // 平滑滚动到 ComfyUI 抽屉设置处
        setTimeout(() => {
            const drawerSec = document.getElementById('comfyui_drawer_settings_container') || document.getElementById('comfy_drawer_settings_container');
            if (drawerSec) drawerSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 200);
    });

    // 全局 ESC 键关闭
    $(document).on('keydown', (e) => {
        if (e.key === 'Escape' && panel.is(':visible')) {
            closeComfyFloatingPanel();
        }
    });

    return panel;
}

/**
 * 持久化记录浮动窗口的位置与大小
 */
function saveFloatingPanelGeometry() {
    const panel = $('#comfy_float_panel');
    if (panel.length === 0 || !panel.is(':visible')) return;
    const rect = panel[0].getBoundingClientRect();
    const geo = {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
    };
    try {
        localStorage.setItem(FLOATING_PANEL_STORAGE_KEY, JSON.stringify(geo));
    } catch (_) {}
}

/**
 * 动态渲染浮动窗口内部的所有预设卡片
 */
function renderFloatingPanelContent() {
    const panel = initComfyFloatingPanel();
    const body = panel.find('#comfy_float_body');
    body.empty();

    const presets = settings.presets || BUILTIN_PRESETS;
    const activePresetId = settings.activePresetId || 'preset_default';

    presets.forEach(p => {
        const isDefault = p.id === activePresetId;
        const shotCount = Math.max(1, Number(p.shotCount) || 1);
        const shotClass = shotCount > 1 ? 'comfy-float-badge-shots multi' : 'comfy-float-badge-shots';
        const shotText = shotCount > 1 ? `${shotCount}段分镜` : '单张出图';
        let resText = '全局分辨率';
        if (p.resolution === 'custom') {
            resText = `${p.customWidth || 832}×${p.customHeight || 1216}`;
        } else if (p.resolution && p.resolution !== 'keep_global') {
            resText = p.resolution;
        }
        const scopeText = getScopeFriendlyName(p.contextScope);

        const card = $(`
            <div class="comfy-float-card" data-preset-id="${p.id}" title="点击立即调用大模型生成并在 ComfyUI 排队出图">
                <div class="comfy-float-card-header">
                    <div class="comfy-float-card-title">
                        <span>${p.name}</span>
                        ${isDefault ? '<span class="comfy-float-card-default-badge">★ 默认</span>' : ''}
                    </div>
                    <i class="fa-solid fa-chevron-right comfy-float-card-arrow"></i>
                </div>
                <div class="comfy-float-card-tags">
                    <span class="comfy-float-badge ${shotClass}">
                        <i class="fa-solid ${shotCount > 1 ? 'fa-clapperboard' : 'fa-image'}"></i> ${shotText}
                    </span>
                    <span class="comfy-float-badge comfy-float-badge-res">
                        <i class="fa-solid fa-vector-square"></i> ${resText}
                    </span>
                    <span class="comfy-float-badge comfy-float-badge-context">
                        <i class="fa-solid fa-filter"></i> ${scopeText}
                    </span>
                </div>
            </div>
        `);

        card.on('click', async function (e) {
            e.stopPropagation();
            const pId = $(this).attr('data-preset-id');
            const context = getContext();
            const chat = context.chat || [];
            if (chat.length === 0) {
                toastr.warning('当前对话暂无任何消息可供参考！');
                return;
            }
            const lastMsgIndex = chat.length - 1;

            // 轻量动效反馈
            card.css('transform', 'scale(0.97)');
            setTimeout(() => card.css('transform', ''), 150);

            toastr.info(`开始执行预设「${p.name}」出图...`, 'ComfyUI 浮窗触发');
            await triggerPresetGeneration(pId, lastMsgIndex);
        });

        body.append(card);
    });
}

/**
 * 打开浮动窗口
 */
function openComfyFloatingPanel() {
    const panel = initComfyFloatingPanel();
    renderFloatingPanelContent();
    panel.fadeIn(180);
}

/**
 * 关闭浮动窗口
 */
function closeComfyFloatingPanel() {
    const panel = $('#comfy_float_panel');
    if (panel.length > 0) {
        saveFloatingPanelGeometry();
        panel.fadeOut(150);
    }
}

/**
 * 切换浮动窗口显隐
 */
function toggleComfyFloatingPanel() {
    const panel = initComfyFloatingPanel();
    if (panel.is(':visible')) {
        closeComfyFloatingPanel();
    } else {
        openComfyFloatingPanel();
    }
}

/**
 * 为单条消息注入生图按钮
 */
function injectDrawButtonToMessage(messageElement) {
    if (!settings.showMessageButton) return;
    if (messageElement.find('.comfy-mes-draw-btn').length > 0) return;

    const extraButtons = messageElement.find('.extraMesButtons');
    const normalButtons = messageElement.find('.mes_buttons');
    const container = extraButtons.length ? extraButtons : normalButtons;

    if (container.length) {
        const btn = $(`
            <div title="使用 ComfyUI 为此消息绘图" class="mes_button comfy-mes-draw-btn fa-solid fa-paintbrush"></div>
        `);

        btn.on('click', function (e) {
            e.stopPropagation();
            const mesId = messageElement.attr('mesid');
            onDrawMessageClick(mesId, $(this));
        });

        container.prepend(btn);
    }
}

/**
 * 绑定设置界面所有表单事件
 */
function bindSettingsUIEvents() {
    // 1. 服务地址与连接模式
    $('#comfy_server_url').val(settings.serverUrl).on('change', function () {
        settings.serverUrl = $(this).val().trim();
        saveSettings();
    });

    $('#comfy_connection_mode').val(settings.connectionMode || 'auto').on('change', function () {
        settings.connectionMode = $(this).val();
        saveSettings();
    });

    // 2. 测试连接按钮与跨域复制
    $('#comfy_test_connection_btn').on('click', () => testComfyConnection(true));

    $('#comfy_copy_cors_flag_btn').on('click', function () {
        const flagText = '--enable-cors-header *';
        navigator.clipboard.writeText(flagText).then(() => {
            toastr.success('已复制启动参数到剪贴板！请将其加在 ComfyUI 启动命令行末尾并重启 ComfyUI。');
        }).catch(() => {
            toastr.info(`请手动复制参数: ${flagText}`);
        });
    });

    // 3. 文件上传与拖拽
    const fileInput = $('#comfy_workflow_file_input');
    const uploadBox = $('#comfy_upload_box');

    uploadBox.on('click', () => fileInput.trigger('click'));

    uploadBox.on('dragover', function (e) {
        e.preventDefault();
        $(this).addClass('dragover');
    });

    uploadBox.on('dragleave', function () {
        $(this).removeClass('dragover');
    });

    uploadBox.on('drop', function (e) {
        e.preventDefault();
        $(this).removeClass('dragover');
        const files = e.originalEvent.dataTransfer.files;
        if (files && files[0]) handleWorkflowFile(files[0]);
    });

    fileInput.on('change', function (e) {
        if (e.target.files && e.target.files[0]) {
            handleWorkflowFile(e.target.files[0]);
        }
    });

    function handleWorkflowFile(file) {
        if (!file.name.endsWith('.json')) {
            toastr.error('请上传 .json 格式的工作流文件！');
            return;
        }

        const reader = new FileReader();
        reader.onload = function (event) {
            try {
                const json = JSON.parse(event.target.result);
                settings.workflowJson = json;
                settings.workflowFilename = file.name;
                updateMappingDropdowns(json);
                autoMatchWorkflowInterfaces(json);
                saveSettings();
                toastr.success(`工作流 ${file.name} 载入成功！共识别出 ${Object.keys(json).length} 个节点。`);
            } catch (err) {
                toastr.error(`解析工作流 JSON 失败: ${err.message}`);
            }
        };
        reader.readAsText(file);
    }

    // 4. 接口选择与配置事件
    $('#comfy_map_prompt_node').on('change', function () {
        settings.promptNodeId = $(this).val();
        saveSettings();
    });

    $('#comfy_map_neg_prompt_node').on('change', function () {
        settings.negativeNodeId = $(this).val();
        saveSettings();
    });

    $('#comfy_map_latent_node').on('change', function () {
        settings.latentNodeId = $(this).val();
        saveSettings();
    });

    $('#comfy_map_output_node').on('change', function () {
        settings.outputNodeId = $(this).val();
        saveSettings();
    });

    $(document).on('change', '.comfy-seed-checkbox', function () {
        const checked = [];
        $('.comfy-seed-checkbox:checked').each(function () {
            checked.push($(this).val());
        });
        settings.seedNodeIds = checked;
        saveSettings();
    });

    $('#comfy_auto_map_btn').on('click', function () {
        if (!settings.workflowJson) {
            toastr.warning('请先上传工作流 API JSON！');
            return;
        }
        autoMatchWorkflowInterfaces(settings.workflowJson);
    });

    // 5. 映射导出与导入
    $('#comfy_export_mapping_btn').on('click', exportMappingConfig);

    const mappingFileInput = $('#comfy_mapping_file_input');
    $('#comfy_import_mapping_btn').on('click', () => mappingFileInput.trigger('click'));
    mappingFileInput.on('change', function (e) {
        if (e.target.files && e.target.files[0]) {
            const file = e.target.files[0];
            const reader = new FileReader();
            reader.onload = (event) => importMappingConfig(event.target.result);
            reader.readAsText(file);
        }
    });

    // 6. 负向词策略与内容
    $('#comfy_override_negative').val(settings.negativeStrategy || 'keep_workflow').on('change', function () {
        settings.negativeStrategy = $(this).val();
        saveSettings();
    });

    $('#comfy_global_negative').val(settings.globalNegative).on('change', function () {
        settings.globalNegative = $(this).val().trim();
        saveSettings();
    });

    // 7. 规则与提示词
    $('#comfy_char_tag_regex').val(settings.charTagRegex).on('change', function () {
        settings.charTagRegex = $(this).val().trim();
        saveSettings();
    });

    $('#comfy_global_prefix').val(settings.globalPrefix).on('change', function () {
        settings.globalPrefix = $(this).val().trim();
        saveSettings();
    });

    // 7.1 预设系统可视化交互与表单管理
    function renderPresetPills() {
        const bar = $('#comfy_preset_pills_bar');
        bar.empty();

        (settings.presets || []).forEach(p => {
            const isEditing = p.id === settings.editingPresetId;
            const isDefault = p.id === settings.activePresetId;
            const defaultStar = isDefault ? '<i class="fa-solid fa-star comfy-pill-star" title="当前默认激活预设"></i>' : '';
            const pill = $(`
                <div class="comfy-preset-pill ${isEditing ? 'active' : ''}" data-id="${p.id}">
                    <span>${p.name}</span>
                    ${defaultStar}
                </div>
            `);
            pill.on('click', function () {
                settings.editingPresetId = p.id;
                renderPresetPills();
                populatePresetForm(p.id);
            });
            bar.append(pill);
        });
    }

    function populatePresetForm(presetId) {
        const p = settings.presets.find(item => item.id === presetId) || settings.presets[0];
        if (!p) return;

        $('#comfy_preset_name').val(p.name);
        $('#comfy_preset_context_scope').val(p.contextScope || 'recent_n');
        $('#comfy_preset_context_count').val(p.contextCount || 3);
        $('#comfy_source_char_card').prop('checked', p.sourceCharCard !== false);
        $('#comfy_source_lorebook').prop('checked', !!p.sourceLorebook);
        $('#comfy_source_user_persona').prop('checked', !!p.sourceUserPersona);
        $('#comfy_preset_extract_prompt').val(p.extractPrompt || '');
        $('#comfy_preset_shot_count').val(p.shotCount || 1);
        $('#comfy_preset_resolution').val(p.resolution || 'keep_global');
        $('#comfy_preset_custom_w').val(p.customWidth || 832);
        $('#comfy_preset_custom_h').val(p.customHeight || 1216);

        $('#comfy_preset_context_count_row').toggle(p.contextScope === 'recent_n');
        $('#comfy_preset_custom_res_row').toggle(p.resolution === 'custom');

        // 系统默认项不允许删除
        if (p.isSystem || p.id === 'preset_default') {
            $('#comfy_delete_preset_btn').prop('disabled', true).attr('title', '系统核心默认项不可删除');
        } else {
            $('#comfy_delete_preset_btn').prop('disabled', false).removeAttr('title');
        }

        // 默认状态标记
        if (p.id === settings.activePresetId) {
            $('#comfy_set_default_preset_btn').prop('disabled', true).html('<i class="fa-solid fa-check"></i> 当前已是默认');
        } else {
            $('#comfy_set_default_preset_btn').prop('disabled', false).html('<i class="fa-solid fa-star"></i> 设为默认激活');
        }
    }

    function saveCurrentPresetFromForm() {
        const p = settings.presets.find(item => item.id === settings.editingPresetId);
        if (!p) return;

        p.name = $('#comfy_preset_name').val().trim() || '未命名预设';
        p.contextScope = $('#comfy_preset_context_scope').val();
        p.contextCount = Math.max(1, Number($('#comfy_preset_context_count').val()) || 3);
        p.sourceCharCard = $('#comfy_source_char_card').is(':checked');
        p.sourceLorebook = $('#comfy_source_lorebook').is(':checked');
        p.sourceUserPersona = $('#comfy_source_user_persona').is(':checked');
        p.extractPrompt = $('#comfy_preset_extract_prompt').val();
        p.shotCount = Math.max(1, Number($('#comfy_preset_shot_count').val()) || 1);
        p.resolution = $('#comfy_preset_resolution').val();
        p.customWidth = Number($('#comfy_preset_custom_w').val()) || 832;
        p.customHeight = Number($('#comfy_preset_custom_h').val()) || 1216;

        saveSettings();
        renderPresetPills();
        if ($('#comfy_float_panel').is(':visible')) {
            renderFloatingPanelContent();
        }
    }

    $('#comfy_preset_context_scope').on('change', function () {
        const scope = $(this).val();
        $('#comfy_preset_context_count_row').toggle(scope === 'recent_n');
        saveCurrentPresetFromForm();
    });

    $('#comfy_preset_resolution').on('change', function () {
        const res = $(this).val();
        $('#comfy_preset_custom_res_row').toggle(res === 'custom');
        saveCurrentPresetFromForm();
    });

    $('#comfy_preset_name, #comfy_preset_context_count, #comfy_preset_shot_count, #comfy_preset_custom_w, #comfy_preset_custom_h').on('input change', saveCurrentPresetFromForm);
    $('#comfy_source_char_card, #comfy_source_lorebook, #comfy_source_user_persona').on('change', saveCurrentPresetFromForm);
    $('#comfy_preset_extract_prompt').on('blur', saveCurrentPresetFromForm);

    $('#comfy_save_current_preset_btn').on('click', function () {
        saveCurrentPresetFromForm();
        toastr.success('预设已保存！');
    });

    // 新增预设
    $('#comfy_add_preset_btn').on('click', function () {
        const newId = 'preset_' + Date.now();
        const newPreset = {
            id: newId,
            name: `新建场景预设 ${settings.presets.length + 1}`,
            contextScope: 'recent_n',
            contextCount: 3,
            sourceCharCard: true,
            sourceLorebook: false,
            sourceUserPersona: false,
            extractPrompt: 'Read the recent dialogue context and generate Danbooru-style tags for {{char}}.\nOutput ONLY comma-separated tags.',
            shotCount: 1,
            resolution: 'keep_global',
            customWidth: 832,
            customHeight: 1216,
            isDefault: false,
            isSystem: false
        };

        settings.presets.push(newPreset);
        settings.editingPresetId = newId;
        saveSettings();
        renderPresetPills();
        populatePresetForm(newId);
        toastr.info('已新建预设，您可以在下方直接编辑配置！');
    });

    // 设为默认激活预设
    $('#comfy_set_default_preset_btn').on('click', function () {
        settings.activePresetId = settings.editingPresetId;
        saveSettings();
        renderPresetPills();
        populatePresetForm(settings.editingPresetId);
        if ($('#comfy_float_panel').is(':visible')) renderFloatingPanelContent();
        toastr.success('已设为默认出图预设！');
    });

    // 删除预设
    $('#comfy_delete_preset_btn').on('click', function () {
        const curId = settings.editingPresetId;
        if (curId === 'preset_default') {
            toastr.warning('系统默认预设不能删除！');
            return;
        }

        settings.presets = settings.presets.filter(p => p.id !== curId);
        if (settings.activePresetId === curId) {
            settings.activePresetId = 'preset_default';
        }
        settings.editingPresetId = settings.presets[0]?.id || 'preset_default';
        saveSettings();
        renderPresetPills();
        populatePresetForm(settings.editingPresetId);
        if ($('#comfy_float_panel').is(':visible')) renderFloatingPanelContent();
        toastr.success('预设已成功删除！');
    });

    // 恢复出厂内置预设
    $('#comfy_reset_presets_btn').on('click', function () {
        if (!confirm('确定要恢复出厂内置预设吗？您自定义添加的预设将会被清空。')) return;
        settings.presets = JSON.parse(JSON.stringify(BUILTIN_PRESETS));
        settings.activePresetId = 'preset_default';
        settings.editingPresetId = 'preset_default';
        saveSettings();
        renderPresetPills();
        populatePresetForm(settings.editingPresetId);
        if ($('#comfy_float_panel').is(':visible')) renderFloatingPanelContent();
        toastr.success('已恢复出厂内置预设！');
    });

    // 初始化渲染预设管理界面
    renderPresetPills();
    populatePresetForm(settings.editingPresetId || settings.activePresetId);

    // 8. 全局分辨率控制
    $('#comfy_default_resolution').val(settings.defaultResolution || 'keep_workflow').on('change', function () {
        settings.defaultResolution = $(this).val();
        $('#comfy_custom_resolution_row').toggle(settings.defaultResolution === 'custom');
        saveSettings();
    });

    $('#comfy_custom_width').val(settings.customWidth).on('change', function () {
        settings.customWidth = Number($(this).val()) || 832;
        saveSettings();
    });

    $('#comfy_custom_height').val(settings.customHeight).on('change', function () {
        settings.customHeight = Number($(this).val()) || 1216;
        saveSettings();
    });

    // 9. 随机种子控制
    $('#comfy_seed_mode').val(settings.seedStrategy || 'random').on('change', function () {
        settings.seedStrategy = $(this).val();
        $('#comfy_fixed_seed_row').toggle(settings.seedStrategy === 'fixed');
        saveSettings();
    });

    $('#comfy_fixed_seed_val').val(settings.fixedSeed || 123456).on('change', function () {
        settings.fixedSeed = Number($(this).val()) || 123456;
        saveSettings();
    });

    // 10. 开关控件
    $('#comfy_auto_generate').prop('checked', settings.autoGenerate).on('change', function () {
        settings.autoGenerate = $(this).is(':checked');
        saveSettings();
    });

    $('#comfy_show_message_button').prop('checked', settings.showMessageButton).on('change', function () {
        settings.showMessageButton = $(this).is(':checked');
        saveSettings();
        $('.comfy-mes-draw-btn').toggle(settings.showMessageButton);
    });

    $('#comfy_show_preview_dialog').prop('checked', settings.showPreviewDialog).on('change', function () {
        settings.showPreviewDialog = $(this).is(':checked');
        saveSettings();
    });

    // 11. 保存与测试
    $('#comfy_save_settings_btn').on('click', function () {
        saveSettings();
        toastr.success('ComfyUI 极简生图设置已全部保存！');
    });

    $('#comfy_test_draw_btn').on('click', async function () {
        const btn = $(this);
        btn.prop('disabled', true).text('正在测试出图...');
        try {
            const testPrompt = assembleFinalPrompt('solo, 1girl, standing, smiling, simple background');
            const result = await executeComfyWorkflow(testPrompt);
            await attachImageToChatMessage(null, result);
        } catch (e) {
            toastr.error(`测试生图失败: ${e.message}`);
        } finally {
            btn.prop('disabled', false).html('<i class="fa-solid fa-play"></i> 立即测试执行出图');
        }
    });

    // 回填初始显示状态
    $('#comfy_custom_resolution_row').toggle(settings.defaultResolution === 'custom');
    $('#comfy_fixed_seed_row').toggle(settings.seedStrategy === 'fixed');

    if (settings.workflowJson) {
        updateMappingDropdowns(settings.workflowJson);
    }
}

/**
 * 扩展初始化入口
 */
jQuery(async () => {
    loadSettings();

    // 1. 动态载入设置 HTML 并追加到设置抽屉中
    try {
        const templateHtml = await renderExtensionTemplateAsync(EXTENSION_DIR, 'settings');
        const container = $('<div id="comfyui_drawer_settings_container" class="extension_container"></div>').append(templateHtml);
        $('#extensions_settings').append(container);
        bindSettingsUIEvents();
        testComfyConnection(false);
    } catch (e) {
        console.error('[ComfyUI Drawer] 载入设置模板失败:', e);
    }

    // 2. 注入已有消息的操作按钮
    $('#chat .mes').each(function () {
        injectDrawButtonToMessage($(this));
    });

    // 3. 监听新消息渲染事件
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
        const msgElement = $(`#chat .mes[mesid="${messageId}"]`);
        if (msgElement.length) {
            injectDrawButtonToMessage(msgElement);
        }
        // 自动出图：AI 角色消息渲染后立即触发按星标默认规则生图
        handleAutoGenerationForMessage(messageId);
    });

    // 4. 监听生成结束事件 (作为保底触发)
    eventSource.on(event_types.GENERATION_ENDED, () => {
        handleAutoGenerationForMessage();
    });

    // 5. 监听聊天切换事件，重置自动出图状态标记
    eventSource.on(event_types.CHAT_CHANGED, () => {
        lastAutoDrawnKey = null;
    });

    // 6. 在魔棒菜单添加快捷入口（点击唤出独立可拖拽生图浮窗）
    const wandItem = $(`
        <div id="comfy_drawer_wand_btn" class="list-group-item flex-container flexGap5 interactable" title="ComfyUI 场景预设生图 (点击开启独立窗口)">
            <i class="fa-solid fa-paintbrush"></i>
            <span>ComfyUI 生图</span>
            <i class="fa-solid fa-up-right-from-square" style="margin-left: auto; opacity: 0.6; font-size: 0.8rem;"></i>
        </div>
    `);
    wandItem.on('click', function (e) {
        e.stopPropagation();
        $('#extensionsMenu').hide();
        toggleComfyFloatingPanel();
    });
    $('#extensionsMenu').append(wandItem);

    // 7. 注册 Slash 指令
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'comfydraw',
        aliases: ['comfy'],
        callback: async (args) => {
            const context = getContext();
            const chat = context.chat || [];
            if (chat.length === 0) return '无消息可出图';
            const lastMsgIndex = chat.length - 1;
            const customPrompt = args?.prompt || '';
            const preset = getActiveStarPreset();

            let finalPrompt = '';
            if (customPrompt) {
                finalPrompt = assembleFinalPrompt(customPrompt, preset);
            } else {
                const generatedTags = await generatePresetSceneTags(preset, lastMsgIndex);
                finalPrompt = assembleFinalPrompt(generatedTags[0] || '', preset);
            }

            const result = await executeComfyWorkflow(
                finalPrompt,
                preset.resolution,
                preset.customWidth,
                preset.customHeight
            );
            await attachImageToChatMessage(lastMsgIndex, result, preset.name);
            return '生图完成';
        },
        unnamedArgumentList: [
            new SlashCommandArgument('prompt', false, '指定生图提示词 (留空则根据上下文自动提取)'),
        ],
        helpString: '通过 ComfyUI 执行极简生图并回传到当前对话中。用法：/comfydraw [可选的额外prompt]',
    }));

    console.log('[ComfyUI Drawer] 极简生图联动插件 v2 已成功初始化！');
});
