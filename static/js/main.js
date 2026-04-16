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

        // ── 연결 ──────────────────────────────────────────────
        const socket = io();

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
        socket.on('disconnect', () => {
            statusText.textContent = '연결 끊김';
            document.querySelector('.status-dot').style.background = 'var(--accent-red)';
        });
        socket.on('connect', () => {
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
        socket.on('new_packet', (data) => {
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
