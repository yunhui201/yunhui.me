"""Isolated usage-page polling, race and unknown-value checks.

Requires Python Playwright + Chromium. Compiles only this component to a temporary
directory; never builds or launches the application or reads a real data profile.
"""
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def test_external_cleanup(browser, bundle):
    """Exercise the real component timers with an isolated clock and RPC fixture."""
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    # Install before the component registers its actual 8-second interval. Advancing
    # this clock exercises the timer; the test never clicks Refresh or sends onUsage.
    page.clock.install()
    page.set_content('<div id="root"></div>')
    page.evaluate("""() => {
      window.hiddenFixture=false;
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.hiddenFixture});
      window.calls={summary:0,recent:0,live:0};
      window.failSummary=false;window.failRecent=false;
      const ts=new Date().toISOString(),day=ts.slice(0,10);
      window.populatedSummary={
        totals:{calls:153,cost:7.42,inputTokens:12000,outputTokens:3000,errors:0,
          cacheRead:2000,cacheWrite:0,cacheReports:72,cacheWriteReports:0,cacheRate:1/6,unpricedCalls:0},
        byDay:[{day,cost:7.42,tokens:15000,calls:153,unpricedCalls:0}],
        byProvider:[{id:'isolated-provider',name:'某某中转站',cost:7.42,tokens:15000,calls:153,unpricedCalls:0}],
        byModel:[{id:'Kimi',cost:7.42,tokens:15000,calls:153,unpricedCalls:0}],
        byAgent:[{id:'isolated-client',calls:153,tokens:15000}]
      };
      window.emptySummary={totals:{calls:0,cost:0,inputTokens:0,outputTokens:0,errors:0,
        cacheRead:0,cacheWrite:0,cacheReports:0,cacheWriteReports:0,cacheRate:0,unpricedCalls:0},
        byDay:[],byProvider:[],byModel:[],byAgent:[]};
      window.populatedRecent=Array.from({length:72},(_,i)=>({ts,requestId:'isolated-'+i,
        status:200,agent:'isolated-client',providerId:'isolated-provider',providerName:'某某中转站',
        model:'Kimi',requestModel:'Kimi',inputTokens:100,outputTokens:20,cacheRead:0,cacheWrite:0,
        latencyMs:10,cost:0.01,costKnown:true,attempts:1}));
      window.sourceSummary=structuredClone(window.populatedSummary);
      window.sourceRecent=structuredClone(window.populatedRecent);
      window.setPopulatedSource=()=>{window.sourceSummary=structuredClone(window.populatedSummary);window.sourceRecent=structuredClone(window.populatedRecent);};
      window.setEmptySource=()=>{window.sourceSummary=structuredClone(window.emptySummary);window.sourceRecent=[];};
      window.aurora={invoke:async(action)=>{
        if(action==='usage.summary'){window.calls.summary++;if(window.failSummary)throw new Error('统计读取失败');return structuredClone(window.sourceSummary);}
        if(action==='usage.recent'){window.calls.recent++;if(window.failRecent)throw new Error('日志读取失败');return structuredClone(window.sourceRecent);}
        if(action==='usage.live'){window.calls.live++;return [];}
        throw new Error('Unexpected action '+action);
      },onUsage:()=>()=>{}};
    }""")
    page.add_script_tag(path=bundle)
    stats = page.locator('.grid.cols-4').first.locator('.stat')

    def populated():
        expect(stats.nth(0)).to_have_text('已知价格估算$7.42')
        expect(stats.nth(2)).to_have_text('调用次数153')
        expect(page.get_by_role('button', name='请求日志 (72)', exact=True)).to_be_visible()
        expect(page.get_by_text('Kimi', exact=True)).to_be_visible()
        expect(page.get_by_text('某某中转站', exact=True)).to_be_visible()
        expect(page.locator('.bars .bar')).to_have_count(1)

    def empty():
        expect(stats.nth(0)).to_have_text('已知价格估算$0')
        expect(stats.nth(1)).to_have_text('总 tokens0')
        expect(stats.nth(2)).to_have_text('调用次数0')
        expect(page.get_by_role('button', name='请求日志 (0)', exact=True)).to_be_visible()
        expect(page.get_by_text('Kimi', exact=True)).to_have_count(0)
        expect(page.get_by_text('某某中转站', exact=True)).to_have_count(0)
        expect(page.locator('.bars .bar')).to_have_count(0)
        expect(page.locator('.grid.cols-2 .list-row')).to_have_count(0)

    try:
        populated()
        baseline = page.evaluate('({...window.calls})')
        page.evaluate('window.setEmptySource()')
        page.clock.run_for(8000)
        empty()
        assert page.evaluate('window.calls.summary') == baseline['summary'] + 1
        assert page.evaluate('window.calls.recent') == baseline['recent'] + 1
        expect(page.get_by_role('alert')).to_have_count(0)
        print('PASS One automatic 8-second poll removes 153/$7.42, Kimi/provider/day groups and all 72 recent records after source cleanup', flush=True)

        page.evaluate('window.setPopulatedSource()')
        page.clock.run_for(8000)
        populated()
        baseline = page.evaluate('({...window.calls})')
        page.evaluate("window.hiddenFixture=true;document.dispatchEvent(new Event('visibilitychange'));window.setEmptySource()")
        page.clock.run_for(16000)
        assert page.evaluate('({...window.calls})') == baseline
        populated()
        page.evaluate("window.hiddenFixture=false;document.dispatchEvent(new Event('visibilitychange'))")
        empty()
        assert page.evaluate('window.calls.summary') == baseline['summary'] + 1
        assert page.evaluate('window.calls.recent') == baseline['recent'] + 1
        print('PASS Hidden pages pause summary/recent/live polling; visibility restoration immediately replaces stale billing state', flush=True)

        page.evaluate('window.setPopulatedSource()')
        page.clock.run_for(8000)
        populated()
        page.evaluate('window.setEmptySource();window.failSummary=true;window.failRecent=true')
        page.clock.run_for(8000)
        populated()
        expect(page.get_by_role('alert')).to_contain_text('用量统计：统计读取失败')
        expect(page.get_by_role('alert')).to_contain_text('请求日志：日志读取失败')
        page.evaluate('window.failSummary=false;window.failRecent=false')
        page.clock.run_for(8000)
        empty()
        expect(page.get_by_role('alert')).to_have_count(0)
        print('PASS Failed reads preserve the last valid billing state with visible errors; the next successful poll clears stale data', flush=True)
        assert errors == [], errors
    finally:
        page.close()


def main():
    with tempfile.TemporaryDirectory(prefix='yunhui-usage-ui-') as temporary:
        bundle = str(Path(temporary) / 'usage.js')
        source = """import React from 'react';
import {createRoot} from 'react-dom/client';
import Usage from './ui/src/pages/Usage.tsx';
window.usageRoot=createRoot(document.getElementById('root'));
window.usageRoot.render(<Usage state={{}}/>);"""
        build = "require('esbuild').buildSync(" + json.dumps({
            'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'},
            'bundle': True, 'platform': 'browser', 'format': 'iife', 'outfile': bundle,
            'define': {'process.env.NODE_ENV': '"production"'},
        }) + ')'
        subprocess.run(['node', '-e', build], cwd=ROOT, check=True)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content('<div id="root"></div>')
            page.evaluate("""() => {
              window.pending=[]; window.liveCalls=0; window.liveFailure=true; window.hiddenFixture=false;
              Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.hiddenFixture});
              window.liveFixture=[{id:'active',model:'test-model',phase:'streaming',startedAtMs:Date.now(),cacheRead:0}];
              window.summaryFixture=(calls)=>({totals:{calls,cost:0,inputTokens:100,outputTokens:20,errors:0,cacheRead:0,cacheWrite:0,cacheReports:1,cacheWriteReports:0,cacheRate:0},byDay:[],byProvider:[],byModel:[],byAgent:[]});
              window.aurora={
                invoke:async(action,payload)=>{
                  if(action==='usage.summary') return await new Promise(resolve=>window.pending.push({days:payload.days,resolve}));
                  if(action==='usage.recent') return [{ts:new Date().toISOString(),requestId:'failed',status:0,agent:'test',model:'test-model',requestModel:'test-model',providerName:'test-provider',inputTokens:0,outputTokens:0,cacheRead:0,cacheWrite:0,latencyMs:0,cost:0}];
                  if(action==='usage.live'){window.liveCalls++;if(window.liveFailure)throw new Error('实时读取失败');return structuredClone(window.liveFixture);}
                  throw new Error('Unexpected action '+action);
                },onUsage:()=>()=>{}
              };
            }""")
            page.add_script_tag(path=bundle)
            expect(page.get_by_role('heading', name='用量统计')).to_be_visible()
            page.wait_for_function('window.pending.length===1')
            stats = page.locator('.grid.cols-4').first
            assert stats.inner_text().count('—') == 4
            print('PASS Pending statistics show unknown values instead of fabricated zeros', flush=True)

            page.get_by_role('button', name='7 天', exact=True).click()
            page.wait_for_function('window.pending.length===2')
            page.evaluate('window.pending[1].resolve(window.summaryFixture(7))')
            expect(stats).to_contain_text('7')
            page.evaluate('window.pending[0].resolve(window.summaryFixture(14))')
            page.wait_for_timeout(100)
            assert '14' not in stats.inner_text()
            expect(page.get_by_role('alert')).to_contain_text('实时读取失败')
            print('PASS Older range responses cannot overwrite a newer range or hide live polling errors', flush=True)

            page.evaluate('window.liveFailure=false')
            expect(page.get_by_text('输出 待返回', exact=True)).to_be_visible(timeout=3000)
            expect(page.get_by_text('缓存读 0', exact=True)).to_be_visible()
            expect(page.get_by_text('缓存写 未提供', exact=True)).to_be_visible()
            expect(page.get_by_role('alert')).to_have_count(0)
            page.evaluate('window.liveFixture[0].estimatedOutputTokens=0')
            expect(page.get_by_text('输出 约 0', exact=True)).to_be_visible(timeout=3000)
            print('PASS Reported zero, absent usage and output estimates remain distinct', flush=True)

            page.get_by_role('button', name='请求日志 (1)', exact=True).click()
            expect(page.locator('td .chip.bad')).to_have_text('ERR')
            print('PASS Transport failures use an error state in request logs', flush=True)

            before = page.evaluate('window.liveCalls')
            page.evaluate('window.hiddenFixture=true')
            page.wait_for_timeout(1700)
            assert page.evaluate('window.liveCalls') == before
            page.evaluate("window.hiddenFixture=false;document.dispatchEvent(new Event('visibilitychange'))")
            page.wait_for_function(f'window.liveCalls>{before}')
            print('PASS Hidden pages pause live polling and refresh immediately when visible', flush=True)

            page.evaluate('window.usageRoot.unmount()')
            page.evaluate('window.pending.forEach(p=>p.resolve(window.summaryFixture(999)))')
            assert errors == [], errors
            page.close()
            test_external_cleanup(browser, bundle)
            browser.close()
            print('8 usage-page browser checks passed.', flush=True)


if __name__ == '__main__':
    main()
