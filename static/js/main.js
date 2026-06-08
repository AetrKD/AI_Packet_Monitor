        // ── 시스템 설정 모달 로직 ──────────────────────────────────
        const menuSettingsBtn = document.getElementById('menuSettingsBtn');
        const configModal = document.getElementById('configModal');
        const closeConfigModal = document.getElementById('closeConfigModal');
        const saveConfigBtn = document.getElementById('saveConfigBtn');
        const cfgPreset = document.getElementById('cfgPreset');

        async function loadConfigIntoForm() {
            try {
                // 인터페이스 목록 불러오기
                const ifaceRes = await fetch('/api/interfaces');
                const ifaceResult = await ifaceRes.json();
                const selIface = document.getElementById('cfgIface');
                if (ifaceResult.success && ifaceResult.data) {
                    selIface.innerHTML = '<option value="all">전체 / 자동 선택</option>';
                    ifaceResult.data.forEach(iface => {
                        const opt = document.createElement('option');
                        opt.value = iface.name;
                        opt.textContent = iface.desc || iface.name;
                        selIface.appendChild(opt);
                    });
                }
                
                // 설정값 불러오기
                const res = await fetch('/api/config');
                const result = await res.json();
                if (result.success) {
                    const d = result.data;
                    document.getElementById('cfgHost').value = d.server?.host || '0.0.0.0';
                    document.getElementById('cfgPort').value = d.server?.port || 25565;
                    if (d.server?.iface) {
                        selIface.value = d.server.iface;
                    }
                    document.getElementById('cfgApiKey').value = d.ai?.api_key || '';
                    document.getElementById('cfgBaseUrl').value = d.ai?.base_url || '';
                    document.getElementById('cfgModel').value = d.ai?.model || '';
                    document.getElementById('cfgTimeout').value = d.ai?.timeout || 30;
                    document.getElementById('cfgThink').checked = d.ai?.disable_thinking ?? true;
                }
            } catch (e) {
                console.error('Failed to load config', e);
            }
        }

        if(menuSettingsBtn) {
            menuSettingsBtn.addEventListener('click', () => {
                loadConfigIntoForm();
                configModal.classList.add('active');
            });
        }
        if(closeConfigModal) {
            closeConfigModal.addEventListener('click', () => configModal.classList.remove('active'));
        }

        if(saveConfigBtn) {
            saveConfigBtn.addEventListener('click', async () => {
                const newConfig = {
                    server: {
                        host: document.getElementById('cfgHost').value.trim(),
                        port: parseInt(document.getElementById('cfgPort').value.trim(), 10) || 25565,
                        iface: document.getElementById('cfgIface').value === 'all' ? null : document.getElementById('cfgIface').value
                    },
                    ai: {
                        api_key: document.getElementById('cfgApiKey').value.trim(),
                        base_url: document.getElementById('cfgBaseUrl').value.trim(),
                        model: document.getElementById('cfgModel').value.trim(),
                        timeout: parseFloat(document.getElementById('cfgTimeout').value.trim()) || 30.0,
                        disable_thinking: document.getElementById('cfgThink').checked
                    }
                };

                try {
                    const res = await fetch('/api/config', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(newConfig)
                    });
                    const result = await res.json();
                    if(result.success) {
                        configModal.classList.remove('active');
                    } else {
                        alert('저장 실패: ' + result.error);
                    }
                } catch (e) {
                    alert('저장 중 네트워크 오류가 발생했습니다.');
                    console.error(e);
                }
            });
        }

        if(cfgPreset) {
            cfgPreset.addEventListener('change', () => {
                const sel = cfgPreset.value;
                if(!sel) return;
                
                const apiEl = document.getElementById('cfgApiKey');
                const baseEl = document.getElementById('cfgBaseUrl');
                const modEl = document.getElementById('cfgModel');
                
                if (sel === 'openai') {
                    baseEl.value = '';
                    if(!apiEl.value || apiEl.value.includes('lm') || apiEl.value.includes('ollama')) {
                        apiEl.value = 'sk-여기에실제키를입력하세요';
                    }
                    if(!modEl.value) modEl.value = 'gpt-4o-mini';
                } else if (sel === 'lmstudio') {
                    baseEl.value = 'http://127.0.0.1:1234/v1';
                    apiEl.value = 'lm-studio';
                } else if (sel === 'ollama') {
                    baseEl.value = 'http://127.0.0.1:11434/v1';
                    apiEl.value = 'ollama';
                } else if (sel === 'anythingllm') {
                    baseEl.value = 'http://127.0.0.1:3001/api/v1/openai';
                    if(!apiEl.value || apiEl.value.includes('lm') || apiEl.value.includes('ollama')) {
                        apiEl.value = 'AnythingLLM_API키';
                    }
                }
            });
        }


        // ── 테마 전환 ──────────────────────────────────────────
        (function initTheme() {
            const saved = localStorage.getItem('netvisor-theme') || 'dark';
            document.documentElement.setAttribute('data-theme', saved);
            const label = document.getElementById('themeLabel');
            if (label) label.textContent = saved === 'light' ? '☀️ 라이트 모드' : '🌙 다크 모드';
        })();

        document.getElementById('themeToggle').addEventListener('click', () => {
            const html = document.documentElement;
            const current = html.getAttribute('data-theme');
            const next = current === 'light' ? 'dark' : 'light';
            html.setAttribute('data-theme', next);
            localStorage.setItem('netvisor-theme', next);
            document.getElementById('themeLabel').textContent =
                next === 'light' ? '☀️ 라이트 모드' : '🌙 다크 모드';

            // Chart.js 그리드 색상도 테마에 맞게 전환
            if (typeof trafficChart !== 'undefined' && trafficChart.options) {
                const gridColor = next === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.05)';
                const tickColor = next === 'light' ? '#8a8aa0' : '#55556a';
                trafficChart.options.scales.y.grid.color = gridColor;
                trafficChart.options.scales.y.ticks.color = tickColor;
                trafficChart.update('none');
            }
        });

        // ── WebSocket 연결 ──────────────────────────────────
        let socket = null;
        const _wsHandlers = {};  // 이벤트 핸들러 맵

        function connectWebSocket() {
            const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            socket = new WebSocket(`${wsProto}//${location.host}/ws`);

            socket.onopen = () => {
                if (_wsHandlers['connect']) _wsHandlers['connect'].forEach(fn => fn());
            };

            socket.onclose = () => {
                if (_wsHandlers['disconnect']) _wsHandlers['disconnect'].forEach(fn => fn());
                // 자동 재연결 (3초 후)
                setTimeout(connectWebSocket, 3000);
            };

            socket.onerror = () => {};

            socket.onmessage = (e) => {
                try {
                    const msg = JSON.parse(e.data);
                    const event = msg.event;
                    const data = msg.data;
                    if (event && _wsHandlers[event]) {
                        _wsHandlers[event].forEach(fn => fn(data));
                    }
                } catch (err) {
                    console.error('WebSocket 메시지 파싱 오류:', err);
                }
            };
        }

        // socket.on 호환 헬퍼
        function onSocket(event, handler) {
            if (!_wsHandlers[event]) _wsHandlers[event] = [];
            _wsHandlers[event].push(handler);
        }

        connectWebSocket();

        // ── 별명(Alias) 전역 캐시 ────────────────────────────────
        let ipAliases = {};

        async function fetchAliases() {
            try {
                const res = await fetch('/api/aliases');
                const result = await res.json();
                if (result.success) ipAliases = result.data || {};
            } catch (e) { Object.keys(e); }
        }

        function resolveIp(ip) {
            if (ipAliases[ip]) {
                return `<span title="${ip}" style="color:var(--accent-blue); font-weight:600;">${ipAliases[ip]}</span>`;
            }
            return ip;
        }

        fetchAliases();

        // ── 전역 상태 ──────────────────────────────────────────
        let currentMode = 'LIVE'; // 'LIVE' or 'ARCHIVE'
        let isSaving = false;

        // ── DOM 참조 ──────────────────────────────────────────
        const packetList = document.getElementById('packetList');
        const countTotal = document.getElementById('count-total');
        const countIn = document.getElementById('count-in');
        const countOut = document.getElementById('count-out');
        const ppsDisplay = document.getElementById('pps-display');
        const statusText = document.getElementById('status-text');

        const tabLive = document.getElementById('tabLive');
        const tabArchive = document.getElementById('tabArchive');
        const tabHighlight = document.getElementById('tabHighlight');
        const topTitle = document.getElementById('topTitle');
        const chartCard = document.querySelector('.chart-card');
        const archiveDateInputs = document.getElementById('archiveDateInputs');
        const saveBtn = document.getElementById('saveBtn');

        const pauseBtn = document.getElementById('pauseBtn');
        const maxPacketsSelect = document.getElementById('maxPacketsSelect');
        const applyFilterBtn = document.getElementById('applyFilterBtn');
        const resetFilterBtn = document.getElementById('resetFilterBtn');

        // 표시 개수 변경 시 즉시 목록 정리
        maxPacketsSelect.addEventListener('change', () => {
            const maxCount = parseInt(maxPacketsSelect.value, 10);
            while (packetList.children.length > maxCount) {
                packetList.lastChild.remove();
            }
        });

        // ── 탭 및 페이징 상태 ──────────────────────────────────────────
        let currentPage = 1;

        // ── 탭 및 모드 전환 ──────────────────────────────────────────
        function setMode(mode) {
            currentMode = mode;
            packetList.innerHTML = '';

            tabLive.classList.remove('active');
            tabArchive.classList.remove('active');
            tabHighlight.classList.remove('active');
            tabHighlight.style.backgroundColor = '';

            const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
            const selectAllCheckbox = document.getElementById('selectAllCheckbox');
            const maxPacketsSelect = document.getElementById('maxPacketsSelect');
            const archiveMaxPacketsSelect = document.getElementById('archiveMaxPacketsSelect');
            const paginationWrap = document.getElementById('paginationWrap');
            if (selectAllCheckbox) selectAllCheckbox.checked = false;

            if (mode === 'LIVE') {
                tabLive.classList.add('active');
                topTitle.textContent = '실시간 패킷 모니터';
                chartCard.style.display = 'block';
                pauseBtn.style.display = 'block';
                saveBtn.style.display = 'block';
                archiveDateInputs.style.display = 'none';
                if (deleteSelectedBtn) deleteSelectedBtn.style.display = 'none';
                if (selectAllCheckbox) selectAllCheckbox.disabled = true;
                if (maxPacketsSelect) maxPacketsSelect.style.display = 'block';
                if (archiveMaxPacketsSelect) archiveMaxPacketsSelect.style.display = 'none';
                if (paginationWrap) paginationWrap.style.display = 'none';
                const batchBtn = document.getElementById('batchAnalyzeBtn');
                if (batchBtn) batchBtn.style.display = 'none';
                firstPacket = true; // 탭 전환 시 첫 패킷 대기 상태로 초기화
                sendFilter();
            } else if (mode === 'ARCHIVE') {
                tabArchive.classList.add('active');
                topTitle.textContent = '데이터베이스 패킷 조회';
                chartCard.style.display = 'none';
                pauseBtn.style.display = 'none';
                saveBtn.style.display = 'none';
                archiveDateInputs.style.display = 'flex';
                if (deleteSelectedBtn) deleteSelectedBtn.style.display = 'inline-block';
                if (selectAllCheckbox) selectAllCheckbox.disabled = false;
                if (maxPacketsSelect) maxPacketsSelect.style.display = 'none';
                if (archiveMaxPacketsSelect) archiveMaxPacketsSelect.style.display = 'block';
                const batchBtn = document.getElementById('batchAnalyzeBtn');
                if (batchBtn) batchBtn.style.display = 'inline-block';
                currentPage = 1;
                sendFilter();
            } else if (mode === 'HIGHLIGHT') {
                tabHighlight.classList.add('active');
                tabHighlight.style.backgroundColor = 'rgba(246, 166, 35, 0.1)';
                topTitle.textContent = '강조 패킷 데이터베이스 조회';
                chartCard.style.display = 'none';
                pauseBtn.style.display = 'none';
                saveBtn.style.display = 'none';
                archiveDateInputs.style.display = 'flex';
                if (deleteSelectedBtn) deleteSelectedBtn.style.display = 'inline-block';
                if (selectAllCheckbox) selectAllCheckbox.disabled = false;
                if (maxPacketsSelect) maxPacketsSelect.style.display = 'none';
                if (archiveMaxPacketsSelect) archiveMaxPacketsSelect.style.display = 'block';
                const batchBtn = document.getElementById('batchAnalyzeBtn');
                if (batchBtn) batchBtn.style.display = 'inline-block';
                currentPage = 1;
                sendFilter();
            }
        }

        tabLive.addEventListener('click', () => setMode('LIVE'));
        tabArchive.addEventListener('click', () => setMode('ARCHIVE'));
        tabHighlight.addEventListener('click', () => setMode('HIGHLIGHT'));

        // ── 삭제 로직 ──────────────────────────────────────────────
        const selectAllCheckbox = document.getElementById('selectAllCheckbox');
        const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');

        if (selectAllCheckbox) {
            selectAllCheckbox.addEventListener('change', (e) => {
                const isChecked = e.target.checked;
                document.querySelectorAll('.row-checkbox').forEach(cb => {
                    cb.checked = isChecked;
                });
            });
        }

        if (deleteSelectedBtn) {
            deleteSelectedBtn.addEventListener('click', async () => {
                const checkedBoxes = document.querySelectorAll('.row-checkbox:checked');
                if (checkedBoxes.length === 0) {
                    alert('삭제할 패킷을 선택해주세요.');
                    return;
                }

                if (!confirm(`선택한 ${checkedBoxes.length}개의 패킷을 영구 삭제하시겠습니까?`)) {
                    return;
                }

                const ids = Array.from(checkedBoxes).map(cb => parseInt(cb.value, 10));

                try {
                    const res = await fetch('/api/delete-packets', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            db_type: currentMode, // 'ARCHIVE' or 'HIGHLIGHT'
                            ids: ids
                        })
                    });
                    const result = await res.json();
                    if (result.success) {
                        if (selectAllCheckbox) selectAllCheckbox.checked = false;
                        sendFilter(); // 리스트 갱신
                    } else {
                        alert('삭제 실패: ' + result.error);
                    }
                } catch (err) {
                    alert('삭제 요청 중 오류 발생: ' + err.message);
                }
            });
        }

        // ── DB 저장 토글 ───────────────────────────────────────────
        saveBtn.addEventListener('click', async () => {
            isSaving = !isSaving;
            saveBtn.textContent = isSaving ? '💾 DB 저장 (On)' : '💾 DB 저장 (Off)';
            saveBtn.style.color = isSaving ? 'var(--accent-amber)' : 'var(--text-primary)';
            try {
                await fetch('/api/toggle-save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ saving: isSaving })
                });
            } catch (e) { }
        });

        // ── 필터 로직 ──────────────────────────────────────────
        async function sendFilter() {
            const filterObj = {
                ip: document.getElementById('filterIp').value,
                port: document.getElementById('filterPort').value,
                proto: document.getElementById('filterProto').value,
                dir: document.getElementById('filterDir').value,
                min_size: document.getElementById('filterMinSize').value,
                max_size: document.getElementById('filterMaxSize').value,
            };

            if (currentMode === 'LIVE') {
                const paginationWrap = document.getElementById('paginationWrap');
                if (paginationWrap) paginationWrap.style.display = 'none';
                try {
                    await fetch('/api/set-filter', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(filterObj)
                    });
                    packetList.innerHTML = '<div class="empty-state"><div class="icon">📡</div><div>필터 조건에 맞는 패킷을 기다리는 중...</div></div>';
                } catch (e) {
                    console.error("Filter apply failed", e);
                }
            } else {
                // ARCHIVE 모드
                const archiveMaxPacketsSelect = document.getElementById('archiveMaxPacketsSelect');
                const limit = parseInt(archiveMaxPacketsSelect ? archiveMaxPacketsSelect.value : "200", 10);

                filterObj.start_time = document.getElementById('filterStart').value.replace('T', ' ');
                filterObj.end_time = document.getElementById('filterEnd').value.replace('T', ' ');
                filterObj.limit = limit;
                filterObj.page = currentPage;

                packetList.innerHTML = '<div class="empty-state"><div class="icon">🔍</div><div>조회 중...</div></div>';
                try {
                    const endpoint = currentMode === 'HIGHLIGHT' ? '/api/highlight-history' : '/api/history';
                    const res = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(filterObj)
                    });
                    const result = await res.json();

                    packetList.innerHTML = '';
                    if (!result.data || result.data.length === 0) {
                        packetList.innerHTML = '<div class="empty-state"><div>해당 조건에 저장된 패킷이 없습니다.</div></div>';
                        document.getElementById('paginationWrap').style.display = 'none';
                        return;
                    }
                    result.data.forEach(data => {
                        const dirBadge = data.direction === 'INBOUND' ? '<span class="badge badge-in">↓ IN</span>' :
                            data.direction === 'OUTBOUND' ? '<span class="badge badge-out">↑ OUT</span>' :
                                '<span class="badge badge-oth">— —</span>';
                        const pBadge = data.proto === 'TCP' ? '<span class="badge badge-tcp">TCP</span>' :
                            data.proto === 'UDP' ? '<span class="badge badge-udp">UDP</span>' :
                                '<span class="badge badge-other">' + data.proto + '</span>';

                        const row = document.createElement('div');
                        row.className = 'packet-row';
                        row.innerHTML = `
                        <div class="col-checkbox"><input type="checkbox" class="row-checkbox" value="${data.no}"></div>
                            <div class="no">${data.no}</div>
                            <div class="time">${data.time}</div>
                            <div class="ip">${resolveIp(data.src)}</div>
                            <div class="ip">${resolveIp(data.dst)}</div>
                            <div>${pBadge}</div>
                            <div>${dirBadge}</div>
                            <div style="color:var(--text-secondary)">${data.len}</div>
                        `;
                        row.addEventListener('click', (e) => {
                            if (e.target.type === 'checkbox') return;
                            document.querySelectorAll('.packet-row').forEach(r => r.classList.remove('selected'));
                            row.classList.add('selected');
                            showAnalysis(data);
                        });
                        packetList.appendChild(row);
                    });

                    renderPagination(result.total, limit);
                } catch (e) {
                    packetList.innerHTML = '<div class="empty-state"><div>오류 발생</div></div>';
                    document.getElementById('paginationWrap').style.display = 'none';
                }
            }
        }

        function renderPagination(total, limit) {
            const paginationWrap = document.getElementById('paginationWrap');
            if (!paginationWrap) return;

            const totalPages = Math.ceil(total / limit);
            if (totalPages <= 1) {
                paginationWrap.style.display = 'none';
                return;
            }

            paginationWrap.style.display = 'flex';
            paginationWrap.innerHTML = '';

            const createBtn = (text, page, disabled = false, active = false) => {
                const btn = document.createElement('button');
                btn.className = 'page-btn';
                if (active) btn.classList.add('active');
                btn.textContent = text;
                btn.disabled = disabled;
                btn.addEventListener('click', () => {
                    currentPage = page;
                    sendFilter();
                });
                return btn;
            };

            // Prev
            paginationWrap.appendChild(createBtn('<<', 1, currentPage === 1));
            paginationWrap.appendChild(createBtn('<', currentPage - 1, currentPage === 1));

            // Pages (10개 노출)
            let startPage = Math.max(1, currentPage - 5);
            let endPage = Math.min(totalPages, startPage + 9);
            if (endPage - startPage < 9) {
                startPage = Math.max(1, endPage - 9);
            }

            for (let i = startPage; i <= endPage; i++) {
                paginationWrap.appendChild(createBtn(i, i, false, i === currentPage));
            }

            // Next
            paginationWrap.appendChild(createBtn('>', currentPage + 1, currentPage === totalPages));
            paginationWrap.appendChild(createBtn('>>', totalPages, currentPage === totalPages));
        }

        document.getElementById('archiveMaxPacketsSelect').addEventListener('change', () => {
            currentPage = 1;
            sendFilter();
        });

        applyFilterBtn.addEventListener('click', () => {
            currentPage = 1;
            sendFilter();
        });

        resetFilterBtn.addEventListener('click', () => {
            document.getElementById('filterIp').value = '';
            document.getElementById('filterPort').value = '';
            document.getElementById('filterProto').value = '';
            document.getElementById('filterDir').value = '';
            document.getElementById('filterMinSize').value = '';
            document.getElementById('filterMaxSize').value = '';
            document.getElementById('filterStart').value = '';
            document.getElementById('filterEnd').value = '';
            currentPage = 1;
            sendFilter();
        });

        // ── 일시정지 로직 ──────────────────────────────────────
        let isPaused = false;
        pauseBtn.addEventListener('click', async () => {
            isPaused = !isPaused;
            pauseBtn.classList.toggle('paused', isPaused);
            pauseBtn.innerHTML = isPaused ? '▶ 계속 (일시정지됨)' : '⏸ 일시정지';

            try {
                await fetch('/api/toggle-pause', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ paused: isPaused })
                });
            } catch (e) {
                console.error('일시정지 상태 변경 실패:', e);
            }
        });

        // ── 카운터 ────────────────────────────────────────────
        let total = 0, inCount = 0, outCount = 0;
        let ppsIn = 0, ppsOut = 0;
        let firstPacket = true;   // 최초 도착 시 empty-state 제거용

        // ── 연결 상태 이벤트 ──────────────────────────────────
        onSocket('disconnect', () => {
            statusText.textContent = '연결 끊김';
            document.querySelector('.status-dot').style.background = 'var(--accent-red)';
        });
        onSocket('connect', () => {
            statusText.textContent = '연결됨';
            document.querySelector('.status-dot').style.background = 'var(--accent-green)';
        });

        // ── Chart.js 설정 ─────────────────────────────────────
        const ctx = document.getElementById('trafficChart').getContext('2d');
        const CHART_POINTS = 30;

        const trafficChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: Array(CHART_POINTS).fill(''),
                datasets: [
                    {
                        label: '수신 (Inbound)',
                        data: Array(CHART_POINTS).fill(0),
                        borderColor: '#3ecf8e',
                        backgroundColor: 'rgba(62, 207, 142, 0.1)',
                        borderWidth: 2,
                        tension: 0.4,
                        fill: true,
                        pointRadius: 0,
                    },
                    {
                        label: '송신 (Outbound)',
                        data: Array(CHART_POINTS).fill(0),
                        borderColor: '#ff6b6b',
                        backgroundColor: 'rgba(255, 107, 107, 0.08)',
                        borderWidth: 2,
                        tension: 0.4,
                        fill: true,
                        pointRadius: 0,
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 200 },
                interaction: { mode: 'index', intersect: false },
                plugins: { legend: { display: false } },
                scales: {
                    x: {
                        display: false,
                    },
                    y: {
                        beginAtZero: true,
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: {
                            color: '#55556a',
                            font: { size: 10, family: 'JetBrains Mono' },
                            maxTicksLimit: 5,
                            precision: 0,
                        }
                    }
                }
            }
        });

        // 0.2초마다 차트 업데이트 (× 5 환산으로 pkt/s 표시)
        const INTERVAL_MS = 200;
        setInterval(() => {
            trafficChart.data.datasets[0].data.push(ppsIn);
            trafficChart.data.datasets[0].data.shift();
            trafficChart.data.datasets[1].data.push(ppsOut);
            trafficChart.data.datasets[1].data.shift();
            trafficChart.update('none');

            // 200ms 단위 카운트 → 초당 환산 (× 5)
            ppsDisplay.textContent = (ppsIn + ppsOut) * (1000 / INTERVAL_MS);
            ppsIn = 0;
            ppsOut = 0;
        }, INTERVAL_MS);

        // ── 패킷 수신 이벤트 ──────────────────────────────────
        onSocket('new_packet', (data) => {
            handleSinglePacket(data);
        });

        onSocket('new_packets', (packets) => {
            if (Array.isArray(packets)) {
                packets.forEach(pkt => handleSinglePacket(pkt));
            }
        });

        function handleSinglePacket(data) {
            if (currentMode === 'ARCHIVE' || currentMode === 'HIGHLIGHT') return; // 아카이브/강조 모드일 때는 그리지 않음

            // 최초 패킷 도착 시 empty-state 제거
            if (firstPacket) {
                packetList.innerHTML = '';
                firstPacket = false;
            }

            const dir = data.direction || 'OTHER';

            // 카운터 업데이트
            total++;
            if (dir === 'INBOUND') { inCount++; ppsIn++; }
            else if (dir === 'OUTBOUND') { outCount++; ppsOut++; }
            else { ppsIn++; } // OTHER도 트래픽으로 간주

            countTotal.textContent = total;
            countIn.textContent = inCount;
            countOut.textContent = outCount;

            // 방향 배지 결정
            let dirBadge = '';
            if (dir === 'INBOUND') dirBadge = '<span class="badge badge-in">↓ IN</span>';
            else if (dir === 'OUTBOUND') dirBadge = '<span class="badge badge-out">↑ OUT</span>';
            else dirBadge = '<span class="badge badge-oth">— —</span>';

            // 프로토콜 배지 결정
            const proto = data.proto || 'OTHER';
            let protoBadge = '';
            if (proto === 'TCP') protoBadge = '<span class="badge badge-tcp">TCP</span>';
            else if (proto === 'UDP') protoBadge = '<span class="badge badge-udp">UDP</span>';
            else protoBadge = '<span class="badge badge-other">' + proto + '</span>';

            // 시간 렌더링 로직
            let timeStr = data.time || '';
            // 혹시나 이전 버전의 Unix Epoch 숫자 문자열인 경우 대비
            if (!timeStr.includes('-') && !isNaN(parseFloat(timeStr))) {
                const d = new Date(parseFloat(timeStr) * 1000);
                const hh = String(d.getHours()).padStart(2, '0');
                const mm = String(d.getMinutes()).padStart(2, '0');
                const ss = String(d.getSeconds()).padStart(2, '0');
                timeStr = `${hh}:${mm}:${ss}`;
            }

            // 행 생성
            const row = document.createElement('div');
            row.className = 'packet-row';
            if (data.highlight) {
                row.className += ' highlighted-packet';
            }
            row.innerHTML = `
                <div class="col-checkbox"><input type="checkbox" class="row-checkbox" value="${data.no}"></div>
                <div class="no">${data.no}</div>
                <div class="time">${timeStr}</div>
                <div class="ip">${resolveIp(data.src)}</div>
                <div class="ip">${resolveIp(data.dst)}</div>
                <div>${protoBadge}</div>
                <div>${dirBadge}</div>
                <div style="color:var(--text-secondary)">${data.len}</div>
            `;

            // 클릭 시 AI 분석 패널 업데이트
            row.addEventListener('click', (e) => {
                if (e.target.type === 'checkbox') return;
                document.querySelectorAll('.packet-row').forEach(r => r.classList.remove('selected'));
                row.classList.add('selected');
                showAnalysis(data);
            });

            packetList.prepend(row);

            // 동적으로 최대 유지 개수 계산
            const maxCount = parseInt(maxPacketsSelect.value, 10);
            while (packetList.children.length > maxCount) {
                packetList.lastChild.remove();
            }
        });

        // ── Hex Dump 포맷터 ───────────────────────────────────
        function formatHexDump(hexStr) {
            if (!hexStr) return '(데이터 없음)';

            // hex 문자열 → byte 배열
            const bytes = [];
            for (let i = 0; i < hexStr.length; i += 2) {
                bytes.push(parseInt(hexStr.substr(i, 2), 16));
            }

            const lines = [];
            for (let offset = 0; offset < bytes.length; offset += 16) {
                const chunk = bytes.slice(offset, offset + 16);

                // 오프셋
                const offsetStr = offset.toString(16).padStart(4, '0');

                // hex 그룹 (8 + 8, 가운데 공백)
                const hexArr = chunk.map(b => b.toString(16).padStart(2, '0'));
                const left = hexArr.slice(0, 8).join(' ').padEnd(23);
                const right = hexArr.slice(8).join(' ').padEnd(23);

                // ASCII
                const ascii = chunk.map(b =>
                    (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '·'
                ).join('');

                lines.push(
                    `<span class="hex-offset">${offsetStr}</span>` +
                    `  <span class="hex-bytes">${left}  ${right}</span>` +
                    `  <span class="hex-ascii">${ascii}</span>`
                );
            }
            return lines.join('\n');
        }

        // ── AI 분석 패널 ──────────────────────────────────────
        let _analysisAbort = null;   // fetch 취소용 AbortController

        async function showAnalysis(data) {
            // Hex Dump 업데이트
            const hexTitle = document.getElementById('hexTitle');
            const hexBox = document.getElementById('hexBox');
            hexTitle.style.display = 'flex';
            hexBox.style.display = 'block';
            hexBox.innerHTML = formatHexDump(data.raw || '');

            // 기존 요청 취소
            if (_analysisAbort) _analysisAbort.abort();
            _analysisAbort = new AbortController();

            const aiBox = document.getElementById('aiBox');

            // ① 기본 패킷 정보 즉시 표시 + 로딩 스피너
            const dir = data.direction || 'OTHER';
            const dirLabel = dir === 'INBOUND' ? '수신 (Inbound)'
                : dir === 'OUTBOUND' ? '송신 (Outbound)' : '기타';

            aiBox.innerHTML = `
                <div class="ai-detail-row">
                    <div class="ai-detail-item">
                        <span class="ai-detail-label">패킷 번호</span>
                        <span class="ai-detail-value">#${data.no}</span>
                    </div>
                    <div class="ai-detail-item">
                        <span class="ai-detail-label">방향</span>
                        <span class="ai-detail-value">${dirLabel}</span>
                    </div>
                    <div class="ai-detail-item">
                        <span class="ai-detail-label">출발지</span>
                        <span class="ai-detail-value">${data.src}</span>
                    </div>
                    <div class="ai-detail-item">
                        <span class="ai-detail-label">목적지</span>
                        <span class="ai-detail-value">${data.dst}</span>
                    </div>
                    <div class="ai-detail-item">
                        <span class="ai-detail-label">프로토콜 / 크기</span>
                        <span class="ai-detail-value">${data.proto} / ${data.len} bytes</span>
                    </div>
                    <div class="ai-detail-item">
                        <span class="ai-detail-label">요약</span>
                        <span class="ai-detail-value" style="font-size:0.75rem;color:var(--text-secondary)">${data.summary}</span>
                    </div>
                    <!-- AI 분석 영역 -->
                    <div class="ai-detail-item" id="aiResultArea">
                        <span class="ai-detail-label">🤖 AI 보안 분석</span>
                        <button id="runAnalysisBtn" class="filter-btn primary" style="width: 100%; margin-top: 8px;">분석하기</button>
                    </div>
                </div>
            `;

            // ② 분석하기 버튼 클릭 시 AI API 호출
            const runAnalysisBtn = document.getElementById('runAnalysisBtn');
            if (runAnalysisBtn) {
                runAnalysisBtn.addEventListener('click', async () => {
                    const area = document.getElementById('aiResultArea');
                    area.innerHTML = `
                        <span class="ai-detail-label">🤖 AI 보안 분석</span>
                        <div class="ai-loading">
                            <div class="spinner"></div>
                            <span>AI 분석 중...</span>
                        </div>
                    `;

                    try {
                        const resp = await fetch('/api/analyze', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(data),
                            signal: _analysisAbort.signal,
                        });

                        const result = await resp.json();
                        const checkArea = document.getElementById('aiResultArea');
                        if (!checkArea) return;

                        if (result.success) {
                            // 위험 수준 배지
                            const riskBadge = `<span class="risk-badge risk-${result.risk_level}">
                                ${result.risk_level === 'HIGH' ? '🔴' :
                                    result.risk_level === 'MEDIUM' ? '🟡' : '🟢'}
                                ${result.risk_level}
                            </span>`;

                            // 태그
                            const tagsHtml = result.tags && result.tags.length
                                ? `<div class="ai-tags">${result.tags.map(t => `<span class="ai-tag">${t}</span>`).join('')}</div>`
                                : '';

                            checkArea.innerHTML = `
                                <span class="ai-detail-label">🤖 AI 보안 분석</span>
                                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                                    ${riskBadge}
                                </div>
                                ${tagsHtml}
                                <div class="ai-opinion ai-analysis-text" id="analysisText"></div>
                            `;

                            // 타이핑 효과
                            typeText(document.getElementById('analysisText'), result.analysis);
                        } else {
                            checkArea.innerHTML = `
                                <span class="ai-detail-label">🤖 AI 보안 분석</span>
                                <div class="ai-error">⚠ ${result.error || '분석에 실패했습니다.'}</div>
                            `;
                        }
                    } catch (err) {
                        if (err.name === 'AbortError') return;  // 취소된 경우 무시
                        const errorArea = document.getElementById('aiResultArea');
                        if (errorArea) {
                            errorArea.innerHTML = `
                                <span class="ai-detail-label">🤖 AI 보안 분석</span>
                                <div class="ai-error">⚠ 서버 통신 오류: ${err.message}</div>
                            `;
                        }
                    }
                });
            }
        }

        // ── 타이핑 효과 ───────────────────────────────────────
        function typeText(el, text, speed = 12) {
            if (!el || !text) return;
            let i = 0;
            el.textContent = '';
            const timer = setInterval(() => {
                el.textContent += text[i++];
                if (i >= text.length) clearInterval(timer);
            }, speed);
        }

        // ── IP 별명 설정 로직 ────────────────────────────────
        const aliasSettingsBtn = document.getElementById('aliasSettingsBtn');
        const aliasModal = document.getElementById('aliasModal');
        const closeAliasModal = document.getElementById('closeAliasModal');
        const addAliasBtn = document.getElementById('addAliasBtn');
        const aliasListContainer = document.getElementById('aliasListContainer');
        const aliasEmptyState = document.getElementById('aliasEmptyState');

        function renderAliasList() {
            aliasListContainer.innerHTML = '';
            const keys = Object.keys(ipAliases);
            if (keys.length === 0) {
                aliasListContainer.appendChild(aliasEmptyState);
            } else {
                keys.forEach((ip) => {
                    const item = document.createElement('div');
                    item.className = 'rule-item';
                    item.innerHTML = `
                        <div class="rule-text"><span style="color:var(--accent-blue); font-weight:600;">${ipAliases[ip]}</span> (${ip})</div>
                        <button onclick="removeAlias('${ip}')">삭제</button>
                    `;
                    aliasListContainer.appendChild(item);
                });
            }
        }

        window.removeAlias = async function (ip) {
            try {
                const res = await fetch('/api/aliases', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ip })
                });
                const result = await res.json();
                if (result.success) {
                    delete ipAliases[ip];
                    renderAliasList();
                }
            } catch (e) {}
        };

        if(addAliasBtn) {
            addAliasBtn.addEventListener('click', async () => {
                const ip = document.getElementById('aliasIp').value.trim();
                const name = document.getElementById('aliasName').value.trim();
                if (!ip || !name) return alert('IP와 이름을 올바르게 입력해주세요.');

                try {
                    const res = await fetch('/api/aliases', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ip, name })
                    });
                    const result = await res.json();
                    if (result.success) {
                        ipAliases[ip] = name;
                        document.getElementById('aliasIp').value = '';
                        document.getElementById('aliasName').value = '';
                        renderAliasList();
                    }
                } catch (e) {}
            });
        }

        if(aliasSettingsBtn) {
            aliasSettingsBtn.addEventListener('click', async () => {
                await fetchAliases();
                aliasModal.classList.add('active');
                renderAliasList();
            });
        }
        if(closeAliasModal) {
            closeAliasModal.addEventListener('click', () => aliasModal.classList.remove('active'));
        }

        // ── 강조 규칙 설정 로직 ────────────────────────────────
        const highlightSettingsBtn = document.getElementById('highlightSettingsBtn');
        const ruleModal = document.getElementById('ruleModal');
        const closeRuleModal = document.getElementById('closeRuleModal');
        const cancelRuleBtn = document.getElementById('cancelRuleBtn');
        const saveRuleBtn = document.getElementById('saveRuleBtn');
        const addRuleBtn = document.getElementById('addRuleBtn');
        const ruleListContainer = document.getElementById('ruleListContainer');
        const ruleEmptyState = document.getElementById('ruleEmptyState');

        // 권한 요청 함수 (알림 기능 삭제됨)
        function requestNotificationPermission() {
            // 알림 기능 비활성화
        }

        let savedRules = []; // 서버로 전송할 리스트

        // DB에서 저장된 규칙을 불러와 savedRules 복원
        async function loadRulesFromDB() {
            try {
                const res = await fetch('/api/rules');
                const result = await res.json();
                if (result.success && result.rules) {
                    savedRules = result.rules;
                }
            } catch (e) {
                console.error('Failed to load rules from DB', e);
            }
        }
        // 페이지 로드 시 자동 복원
        loadRulesFromDB();

        function renderRuleList() {
            ruleListContainer.innerHTML = '';
            if (savedRules.length === 0) {
                ruleListContainer.appendChild(ruleEmptyState);
            } else {
                savedRules.forEach((rule, idx) => {
                    const item = document.createElement('div');
                    item.className = 'rule-item';

                    const conditions = [];
                    if (rule.ip) conditions.push(`IP: ${rule.ip}`);
                    if (rule.port) conditions.push(`Port: ${rule.port}`);
                    if (rule.proto) conditions.push(`Proto: ${rule.proto}`);
                    if (rule.dir) conditions.push(`Dir: ${rule.dir}`);
                    if (rule.min_size || rule.max_size) conditions.push(`Size: ${rule.min_size || 0}~${rule.max_size || '무한'}`);

                    const actionBadge = rule.action === 'IGNORE' ? '🔴 [무시]' : '🟢 [강조]';
                    const descText = rule.description ? ` — <span style="color:var(--text-secondary);font-style:italic">${rule.description}</span>` : '';
                    item.innerHTML = `
                        <div class="rule-text"><span style="font-weight:600">${actionBadge}</span> | ${conditions.length > 0 ? conditions.join(', ') : '전체 패킷'}${descText}</div>
                        <button onclick="removeRule(${idx})">삭제</button>
                    `;
                    ruleListContainer.appendChild(item);
                });
            }
        }

        window.removeRule = function (idx) {
            savedRules.splice(idx, 1);
            renderRuleList();
        };

        addRuleBtn.addEventListener('click', () => {
            const ruleObj = {
                action: document.getElementById('ruleAction').value,
                ip: document.getElementById('ruleIp').value.trim(),
                port: document.getElementById('rulePort').value.trim(),
                proto: document.getElementById('ruleProto').value.trim(),
                dir: document.getElementById('ruleDir').value.trim(),
                min_size: document.getElementById('ruleMinSize').value.trim(),
                max_size: document.getElementById('ruleMaxSize').value.trim(),
                description: document.getElementById('ruleDesc').value.trim()
            };

            const isEmpty = !ruleObj.ip && !ruleObj.port && !ruleObj.proto && !ruleObj.dir && !ruleObj.min_size && !ruleObj.max_size;
            if (isEmpty) {
                alert('최소 한 가지 이상의 조건을 지정해주세요.');
                return;
            }

            savedRules.push(ruleObj);

            // 폼 초기화
            document.getElementById('ruleIp').value = '';
            document.getElementById('rulePort').value = '';
            document.getElementById('ruleProto').value = '';
            document.getElementById('ruleDir').value = '';
            document.getElementById('ruleMinSize').value = '';
            document.getElementById('ruleMaxSize').value = '';
            document.getElementById('ruleDesc').value = '';

            renderRuleList();
        });

        highlightSettingsBtn.addEventListener('click', async () => {
            await loadRulesFromDB();
            ruleModal.classList.add('active');
            renderRuleList();
        });

        closeRuleModal.addEventListener('click', () => ruleModal.classList.remove('active'));
        cancelRuleBtn.addEventListener('click', () => ruleModal.classList.remove('active'));

        saveRuleBtn.addEventListener('click', async () => {
            try {
                const res = await fetch('/api/set-rules', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rules: savedRules })
                });
                const result = await res.json();
                if (result.success) {
                    ruleModal.classList.remove('active');
                } else {
                    alert('저장에 실패했습니다.');
                }
            } catch (e) {
                alert('서버 오류 발생');
            }
        });

        // ── AI 패널 리사이징 로직 ───────────────────────────────
        const resizer = document.getElementById('resizer');
        const aiPanel = document.getElementById('aiPanel');
        let isResizing = false;

        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            resizer.classList.add('active');
            document.body.style.userSelect = 'none'; // 텍스트 선택 방지
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            // 오른쪽에서부터 커서까지의 거리 = 브라우저 윈도우 폭 - 마우스 X 좌표
            let newWidth = window.innerWidth - e.clientX;
            // CSS에 지정된 min / max를 자바스크립트에서도 제한 처리 (좀 더 부드러움)
            if (newWidth < 300) newWidth = 300;
            if (newWidth > 900) newWidth = 900;
            aiPanel.style.width = `${newWidth}px`;
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                resizer.classList.remove('active');
                document.body.style.userSelect = '';
            }
        });

        // ── 페이지 로드 시 AI 상태 확인 ──────────────────────
        (async () => {
            try {
                const r = await fetch('/api/ai-status');
                const s = await r.json();
                const keyEl = document.getElementById('aiKeyStatus');
                const modelEl = document.getElementById('aiModelTag');
                if (s.configured) {
                    keyEl.textContent = `✓ ${s.backend}`;
                    keyEl.className = 'ai-key-ok';
                } else {
                    keyEl.textContent = '⚠ API 키 미설정 (.env 확인)';
                    keyEl.className = 'ai-key-none';
                }
                modelEl.textContent = s.model || '-';
                modelEl.title = `백엔드: ${s.base_url}`;  // 마우스 오버 시 URL 표시
            } catch (e) {
                console.warn('AI 상태 확인 실패:', e);
            }
        })();

        // ════════════════════════════════════════════════════════
        // ── 패킷 데이터 저장소 (배치 분석용) ──────────────────────
        // ════════════════════════════════════════════════════════
        const packetDataStore = {}; // { no: packetData }

        // ARCHIVE/HIGHLIGHT 탭에서 행 렌더링 시 데이터 저장 (sendFilter 함수 내)
        // result.data.forEach 부분에서 호출됨 — 아래 패치로 기존 로직에 추가
        const _origSendFilter = sendFilter;

        // 저장소 채우기: sendFilter가 결과를 렌더링할 때 packetDataStore에도 저장
        // (기존 sendFilter 코드 내 result.data.forEach 에서 packetDataStore[data.no] = data 삽입)
        // → 아래 socket 'new_packet' 핸들러에서도 실시간 패킷 저장
        onSocket('new_packet', (data) => {
            // 실시간 패킷도 저장소에 저장
            packetDataStore[data.no] = data;
        });

        // ── 배치 분석 버튼 ────────────────────────────────────────
        const batchAnalyzeBtn = document.getElementById('batchAnalyzeBtn');
        const batchResultModal = document.getElementById('batchResultModal');
        const closeBatchModal = document.getElementById('closeBatchModal');
        const batchResultBody = document.getElementById('batchResultBody');

        if (closeBatchModal) {
            closeBatchModal.addEventListener('click', () => batchResultModal.classList.remove('active'));
        }

        if (batchAnalyzeBtn) {
            batchAnalyzeBtn.addEventListener('click', async () => {
                const checkedBoxes = document.querySelectorAll('.row-checkbox:checked');
                if (checkedBoxes.length === 0) {
                    alert('분석할 패킷을 체크박스로 선택해주세요.');
                    return;
                }

                // 선택된 패킷 데이터 수집
                const selectedPackets = [];
                checkedBoxes.forEach(cb => {
                    const no = parseInt(cb.value, 10);
                    const row = cb.closest('.packet-row');
                    // 행에서 기본 정보 추출
                    const cells = row.querySelectorAll('div:not(.col-checkbox)');
                    const pkt = packetDataStore[no] || {
                        no,
                        src: cells[2]?.textContent?.trim() || '?',
                        dst: cells[3]?.textContent?.trim() || '?',
                        proto: cells[4]?.textContent?.trim() || '?',
                        direction: cells[5]?.textContent?.trim() || '?',
                        len: cells[6]?.textContent?.trim() || '?',
                        summary: ''
                    };
                    selectedPackets.push(pkt);
                });

                // 모달 표시 (로딩)
                batchResultBody.innerHTML = `
                    <div style="padding: 40px 0; text-align: center; color: var(--text-secondary);">
                        <div class="spinner" style="margin: 0 auto 12px;"></div>
                        <div>${selectedPackets.length}개 패킷 AI 분석 중...</div>
                    </div>`;
                batchResultModal.classList.add('active');

                try {
                    const res = await fetch('/api/analyze-batch', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ packets: selectedPackets })
                    });
                    const result = await res.json();

                    if (result.success) {
                        const riskColor = result.risk_color || '#8888a8';
                        const patternsHtml = result.patterns && result.patterns.length
                            ? `<div class="ai-tags" style="margin: 8px 0;">${result.patterns.map(p => `<span class="ai-tag">${p}</span>`).join('')}</div>`
                            : '';
                        batchResultBody.innerHTML = `
                            <div style="margin-bottom: 12px; display: flex; align-items: center; gap: 10px;">
                                <span style="font-size: 0.8rem; font-weight: 700; padding: 3px 10px; border-radius: 20px; background: ${riskColor}22; color: ${riskColor}; border: 1px solid ${riskColor}44;">
                                    ${result.risk_level === 'HIGH' ? '🔴' : result.risk_level === 'MEDIUM' ? '🟡' : '🟢'} ${result.risk_level}
                                </span>
                                <span style="font-size: 0.78rem; color: var(--text-dim);">${result.packet_count}개 패킷 분석 완료</span>
                            </div>
                            ${patternsHtml}
                            <div style="font-size: 0.85rem; line-height: 1.7; color: var(--text-primary); margin-bottom: 12px;">${result.summary}</div>
                            ${result.recommendations ? `<div style="padding: 10px 12px; background: var(--bg-tertiary); border-radius: 6px; font-size: 0.82rem; color: var(--text-secondary); border-left: 3px solid ${riskColor};">
                                💡 <strong>권고사항:</strong> ${result.recommendations}
                            </div>` : ''}`;
                    } else {
                        batchResultBody.innerHTML = `<div class="ai-error" style="padding: 20px;">⚠ ${result.error || '분석에 실패했습니다.'}</div>`;
                    }
                } catch (e) {
                    batchResultBody.innerHTML = `<div class="ai-error" style="padding: 20px;">⚠ 서버 통신 오류: ${e.message}</div>`;
                }
            });
        }

        // ── 알림 벨 버튼 & 드롭다운 패널 ─────────────────────────
        const alertBellBtn = document.getElementById('alertBellBtn');
        const alertPanel = document.getElementById('alertPanel');
        const alertBadge = document.getElementById('alertBadge');
        const alertList = document.getElementById('alertList');
        const clearAlertsBtn = document.getElementById('clearAlertsBtn');
        let alertCount = 0;
        let alertPanelOpen = false;

        if (alertBellBtn) {
            alertBellBtn.addEventListener('click', () => {
                alertPanelOpen = !alertPanelOpen;
                alertPanel.style.display = alertPanelOpen ? 'block' : 'none';
                if (alertPanelOpen) {
                    // 패널 열면 배지 초기화
                    alertBadge.style.display = 'none';
                    alertBadge.textContent = '0';
                    alertCount = 0;
                }
            });
        }

        if (clearAlertsBtn) {
            clearAlertsBtn.addEventListener('click', () => {
                alertList.innerHTML = '<div style="padding: 16px 12px; color: var(--text-dim); text-align: center;">알림 없음</div>';
                alertCount = 0;
                alertBadge.style.display = 'none';
            });
        }

        // ── ai_alert 소켓 이벤트 수신 ─────────────────────────────
        const alertDetailModal = document.getElementById('alertDetailModal');
        const alertDetailBody = document.getElementById('alertDetailBody');
        const alertDetailTitle = document.getElementById('alertDetailTitle');
        const closeAlertDetailModal = document.getElementById('closeAlertDetailModal');

        if (closeAlertDetailModal) {
            closeAlertDetailModal.addEventListener('click', () => alertDetailModal.classList.remove('active'));
        }

        function openAlertDetail(packet, analysis) {
            const riskColor = analysis.risk_color || '#8888a8';
            const tagsHtml = analysis.tags && analysis.tags.length
                ? `<div class="ai-tags" style="margin: 8px 0;">${analysis.tags.map(t => `<span class="ai-tag">${t}</span>`).join('')}</div>`
                : '';
            alertDetailTitle.innerHTML = `🤖 AI 위협 분석 — <span style="font-size:0.8rem; color:var(--text-secondary);">${packet.src} → ${packet.dst}</span>`;
            alertDetailBody.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">
                    <span style="font-size:0.82rem; font-weight:700; padding: 3px 12px; border-radius:20px;
                        background:${riskColor}22; color:${riskColor}; border:1px solid ${riskColor}44;">
                        ${analysis.risk_level === 'HIGH' ? '🔴' : analysis.risk_level === 'MEDIUM' ? '🟡' : '🟢'} ${analysis.risk_level}
                    </span>
                    <span style="font-size:0.78rem; color:var(--text-dim);">${packet.proto} | ${packet.len ?? '?'} bytes | ${packet.direction ?? '?'}</span>
                </div>
                ${tagsHtml}
                <div style="font-size:0.85rem; line-height:1.75; color:var(--text-primary); padding: 10px 0; border-top: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color); margin-bottom: 10px;">
                    ${analysis.analysis}
                </div>
                <div style="font-size:0.78rem; color:var(--text-dim);">
                    <span style="margin-right:12px;">📤 출발지: <strong style="color:var(--text-secondary);">${packet.src}</strong></span>
                    <span>📥 목적지: <strong style="color:var(--text-secondary);">${packet.dst}</strong></span>
                </div>`;
            alertDetailModal.classList.add('active');
        }

        onSocket('ai_alert', ({ packet, analysis }) => {
            const riskColor = analysis.risk_color || '#8888a8';
            const tagsHtml = analysis.tags && analysis.tags.length
                ? analysis.tags.map(t => `<span style="font-size:0.68rem; padding: 1px 6px; border-radius: 10px; background: var(--bg-tertiary); color: var(--text-secondary); margin-right: 3px;">${t}</span>`).join('')
                : '';
            const itemHtml = `
                <div class="alert-item" style="padding: 8px 12px; border-bottom: 1px solid var(--border-color); cursor: pointer; transition: background 0.15s;"
                    onmouseenter="this.style.background='var(--bg-tertiary)'" onmouseleave="this.style.background=''"
                    data-packet='${JSON.stringify(packet).replace(/'/g, "&apos;")}'
                    data-analysis='${JSON.stringify(analysis).replace(/'/g, "&apos;")}'>
                    <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 3px;">
                        <span style="width: 8px; height: 8px; border-radius: 50%; background: ${riskColor}; flex-shrink: 0;"></span>
                        <span style="font-weight: 600; color: var(--text-primary); font-size:0.82rem;">${packet.src} → ${packet.dst}</span>
                        <span style="color: var(--text-dim); font-size: 0.7rem; margin-left: auto;">${packet.proto}</span>
                    </div>
                    <div style="font-size:0.75rem; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${analysis.analysis?.substring(0,60)}...</div>
                </div>`;

            // 첫 알림이면 '알림 없음' 텍스트 제거
            if (alertList.children.length === 0 || alertList.querySelector('div[style*="text-align: center"]')) {
                alertList.innerHTML = '';
            }
            alertList.insertAdjacentHTML('afterbegin', itemHtml);

            // 방금 추가된 항목에 클릭 이벤트 연결
            alertList.firstElementChild.addEventListener('click', function() {
                const p = JSON.parse(this.dataset.packet);
                const a = JSON.parse(this.dataset.analysis);
                openAlertDetail(p, a);
            });

            // 패널이 닫혀있으면 배지 표시
            if (!alertPanelOpen) {
                alertCount++;
                alertBadge.textContent = alertCount > 9 ? '9+' : alertCount;
                alertBadge.style.display = 'block';
                // 벨 아이콘 잠깐 흔들기 효과
                alertBellBtn.style.transform = 'scale(1.3)';
                setTimeout(() => { alertBellBtn.style.transform = ''; }, 300);
            }
        });

        // ── 자동 AI 분석 토글 ─────────────────────────────────────
        const autoAnalysisToggle = document.getElementById('autoAnalysisToggle');
        const autoAnalysisStatus = document.getElementById('autoAnalysisStatus');
        let autoAnalysisEnabled = false;

        if (autoAnalysisToggle) {
            autoAnalysisToggle.addEventListener('click', async () => {
                autoAnalysisEnabled = !autoAnalysisEnabled;
                try {
                    await fetch('/api/auto-analysis-toggle', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ enabled: autoAnalysisEnabled })
                    });
                    autoAnalysisStatus.textContent = autoAnalysisEnabled ? 'ON' : 'OFF';
                    autoAnalysisStatus.style.color = autoAnalysisEnabled ? 'var(--accent-green, #3ecf8e)' : 'var(--text-dim)';
                    autoAnalysisToggle.style.borderColor = autoAnalysisEnabled ? 'rgba(62,207,142,0.4)' : 'var(--border-color)';
                } catch (e) {
                    autoAnalysisEnabled = !autoAnalysisEnabled; // 롤백
                }
            });
        }
