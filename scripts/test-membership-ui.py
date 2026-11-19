"""Isolated membership recovery tests: mocked IPC, no profile or network access."""
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='yunhui-membership-ui-') as temporary:
        bundle = Path(temporary) / 'ui.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import Membership from './ui/src/pages/Membership.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));
window.renderMember=()=>root.render(<ToastHost key={window.generation}><Membership state={{}} reload={async()=>{window.reloads++}} go={page=>{window.destination=page}}/></ToastHost>);"""
        options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle), 'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
        subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1380, 'height': 1000})
            page.route('**/*', lambda route: route.abort())
            errors, checks = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content('<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
            for stylesheet in ['app.css', 'workspace.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / stylesheet))
            page.evaluate("""()=>{
              window.generation=0;
              window.reset=()=>{window.generation++;window.calls=[];window.claimError='';window.statusError='';window.groupError='';window.expired=false;window.claimPending=false;window.pendingClaim=null;window.nextGift=null;window.statusPending=false;window.pendingStatus=null;window.login2fa=false;window.reloads=0;window.destination='';
                window.memberStatus={ok:true,loggedIn:true,config:{enabled:true,giftEnabled:true,giftUsd:10,currency:'USD',giftMessage:'当前活动说明由平台提供',giftPolicyRevision:'fixture-policy'},member:{email:'fixture@example.invalid',balance:0},gift:{status:'eligible',amountUsd:10}};
                window.claimResult={ok:true,message:'平台已确认到账',gift:{status:'claimed',claimed:true,amountUsd:10},member:{balance:10}};window.renderMember?.();};
              window.aurora={invoke:async(action,payload)=>{window.calls.push({action,payload});
                if(action==='member.status'){if(window.statusPending)await new Promise(resolve=>window.pendingStatus=resolve);if(window.statusError)throw Error(window.statusError);return structuredClone(window.memberStatus);}
                if(action==='member.groups'){if(window.groupError)throw Error(window.groupError);return {ok:true,groups:[{id:7,name:'测试分组',platform:'openai',supported:true}]};}
                if(action==='member.logout'){window.memberStatus={ok:true,loggedIn:false,config:window.memberStatus.config};return {ok:true};}
                if(action==='member.login'&&window.login2fa)return {ok:true,requires2fa:true,tempToken:'fixture-two-factor',emailMasked:'f***@example.invalid'};
                if(['member.login','member.login2fa','member.bind'].includes(action)){window.memberStatus.loggedIn=true;window.memberStatus.canRefresh=action!=='member.bind';return {ok:true};}
                if(action==='member.addProvider')return {ok:true,providerId:'fixture-provider',message:'会员供应商已添加'};
                if(action==='provider.models')return {ok:true};
                if(action==='member.claim'){
                  if(window.claimPending)await new Promise(resolve=>window.pendingClaim=resolve);
                  if(window.nextGift)window.memberStatus.gift=structuredClone(window.nextGift);
                  if(window.expired){window.memberStatus={ok:true,loggedIn:false,config:window.memberStatus.config,message:'登录已过期，请重新登录。'};return {ok:false,authExpired:true,loggedIn:false,message:'登录已过期，请重新登录。'};}
                  if(window.claimError)throw Error(window.claimError);
                  window.memberStatus.gift=structuredClone(window.claimResult.gift);window.memberStatus.member=structuredClone(window.claimResult.member);return structuredClone(window.claimResult);
                }
                throw Error('Unexpected mock action '+action);
              }};window.reset();
            }""")
            page.add_script_tag(path=str(bundle))
            page.evaluate('window.renderMember()')

            def ready():
                expect(page.get_by_role('button', name='领取 $10 平台额度', exact=True)).to_be_enabled()

            def reset():
                page.evaluate('window.reset()')
                ready()

            def claim_count():
                return page.evaluate("window.calls.filter(call=>call.action==='member.claim').length")

            ready()
            assert page.evaluate("Object.hasOwn(window.memberStatus.gift,'eligible')") is False
            expect(page.get_by_label('平台赠送额度').locator('strong')).to_have_text('$10')
            checks.append('The real service shape status=eligible plus amountUsd enables claiming without an invented eligible boolean')
            page.evaluate("window.claimError='上游响应中断';window.nextGift={status:'pending',eligible:false,amountUsd:10,message:'正在核对领取结果'}")
            page.get_by_role('button', name='领取 $10 平台额度', exact=True).click()
            expect(page.get_by_text('到账确认中', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='重新确认到账', exact=True)).to_be_enabled()
            expect(page.get_by_role('alert')).to_contain_text('上游响应中断')
            assert claim_count() == 1
            assert page.evaluate("window.calls.filter(call=>call.action==='member.status').length") == 2
            page.evaluate("window.claimError='';window.nextGift=null")
            page.get_by_role('button', name='重新确认到账', exact=True).click()
            expect(page.get_by_role('button', name='新客额度已到账', exact=True)).to_be_disabled()
            assert claim_count() == 2
            checks.append('Ambiguous claim reloads status once, preserves the failure, and enables pending confirmation only on another explicit click')

            reset()
            page.evaluate("window.claimError='无法读取领取响应';window.nextGift={status:'ineligible',eligible:false,reason:'本机已领取'}")
            page.get_by_role('button', name='领取 $10 平台额度', exact=True).click()
            expect(page.get_by_role('button', name='领取 $10 平台额度', exact=True)).to_be_disabled()
            expect(page.get_by_role('alert')).to_contain_text('无法读取领取响应')
            assert claim_count() == 1
            checks.append('Reconciliation replaces stale eligibility with the server ineligible result')

            reset()
            page.evaluate("window.claimError='领取请求结果未知';window.statusError='状态接口离线'")
            page.get_by_role('button', name='领取 $10 平台额度', exact=True).click()
            expect(page.get_by_text('资格待确认', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='请先刷新领取状态', exact=True)).to_be_disabled()
            expect(page.get_by_role('alert')).to_contain_text('领取请求结果未知；状态确认失败：状态接口离线')
            assert claim_count() == 1
            page.evaluate("window.statusError='';window.memberStatus.gift={status:'pending',eligible:false,amountUsd:10}")
            page.get_by_role('button', name='重试', exact=True).click()
            expect(page.get_by_role('button', name='重新确认到账', exact=True)).to_be_enabled()
            assert claim_count() == 1
            checks.append('Failed status verification blocks a new claim; the error retry only reads status')

            reset()
            page.evaluate("window.expired=true;window.statusError='配置服务暂不可用'")
            page.get_by_role('button', name='领取 $10 平台额度', exact=True).click()
            expect(page.get_by_role('textbox', name='平台会员邮箱', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='退出会员登录', exact=True)).to_have_count(0)
            expect(page.get_by_role('alert')).to_contain_text('登录已过期')
            expect(page.get_by_role('alert')).to_contain_text('配置服务暂不可用')
            assert claim_count() == 1
            checks.append('Expired authentication clears the logged-in UI even when follow-up config/status reads also fail')

            reset()
            page.evaluate("window.groupError='分组服务暂不可用'")
            page.get_by_role('button', name='领取 $10 平台额度', exact=True).click()
            expect(page.get_by_role('button', name='新客额度已到账', exact=True)).to_be_disabled()
            expect(page.get_by_text('平台已确认到账', exact=True).first).to_be_visible()
            expect(page.get_by_role('alert')).to_contain_text('分组服务暂不可用')
            expect(page.get_by_role('button', name='添加云汇供应商 →', exact=True)).to_be_disabled()
            assert claim_count() == 1
            checks.append('Group discovery failure stays separate from a confirmed claim and its receipt')

            reset()
            page.evaluate("window.statusError='到账后的状态读取失败'")
            page.get_by_role('button', name='领取 $10 平台额度', exact=True).click()
            expect(page.get_by_role('button', name='新客额度已到账', exact=True)).to_be_disabled()
            expect(page.get_by_text('平台已确认到账', exact=True).first).to_be_visible()
            assert claim_count() == 1
            checks.append('A successful claim result remains authoritative if the following status read fails')

            reset()
            page.evaluate("window.claimPending=true;window.claimError='稍后确认';window.nextGift={status:'pending',eligible:false,amountUsd:10}")
            page.get_by_role('button', name='领取 $10 平台额度', exact=True).click()
            expect(page.get_by_role('button', name='正在确认到账…', exact=True)).to_be_disabled()
            assert claim_count() == 1
            page.evaluate('window.pendingClaim()')
            expect(page.get_by_role('button', name='重新确认到账', exact=True)).to_be_enabled()
            assert claim_count() == 1
            checks.append('An in-flight claim disables duplicate clicks and is not repeated by failure recovery')

            reset()
            page.get_by_role('button', name='领取 $10 平台额度', exact=True).click()
            expect(page.get_by_role('button', name='新客额度已到账', exact=True)).to_be_disabled()
            page.evaluate("window.statusError='退出后的状态服务离线'")
            page.get_by_role('button', name='退出会员登录', exact=True).click()
            expect(page.get_by_role('textbox', name='平台会员邮箱', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='退出会员登录', exact=True)).to_have_count(0)
            expect(page.get_by_role('button', name='新客额度已到账', exact=True)).to_have_count(0)
            expect(page.locator('.member-steps').locator('..').get_by_text('平台已确认到账', exact=True)).to_have_count(0)
            expect(page.get_by_text('fixture@example.invalid', exact=True)).to_have_count(0)
            expect(page.get_by_role('alert')).to_contain_text('退出后的状态服务离线')
            expect(page.get_by_role('button', name='请先刷新领取状态', exact=True)).to_be_disabled()
            assert page.evaluate("window.calls.filter(call=>call.action==='member.logout').length") == 1
            assert claim_count() == 1
            checks.append('Logout clears the account and receipt immediately even if the following status read fails')

            page.evaluate('window.reset();window.memberStatus.canRefresh=true;window.renderMember()')
            ready()
            expect(page.get_by_text('登录状态会自动续期，无需每小时重新登录。', exact=False)).to_be_visible()
            page.evaluate('window.reset();window.memberStatus.canRefresh=false;window.renderMember()')
            ready()
            expect(page.get_by_text('当前登录不支持自动续期，访问令牌到期后需要重新绑定。', exact=False)).to_be_visible()
            page.get_by_role('button', name='退出会员登录', exact=True).click()
            page.get_by_text('通过平台访问令牌绑定', exact=True).click()
            expect(page.get_by_text('此方式不能自动续期，令牌到期后需重新绑定。', exact=False)).to_be_visible()
            assert claim_count() == 0
            checks.append('Renewable and legacy/manual sessions have truthful renewal guidance; the token binding form explains its limit')

            for amount, label in [(5, '$5'), (25.5, '$25.50')]:
                page.evaluate("amount=>{window.reset();window.memberStatus.config.giftUsd=amount;delete window.memberStatus.gift.amountUsd;window.renderMember()}", amount)
                expect(page.get_by_role('button', name=f'领取 {label} 平台额度', exact=True)).to_be_enabled()
                expect(page.get_by_label('平台赠送额度').locator('strong')).to_have_text(label)
                expect(page.get_by_text(f'绑定并领取 {label}', exact=True)).to_be_visible()
                expect(page.get_by_text('当前活动说明由平台提供', exact=True)).to_be_visible()
                assert claim_count() == 0
            checks.append('Server campaign values 5 and 25.50 update the hero, steps and claim action without a fixed promotion')

            page.evaluate("window.reset();window.memberStatus.config.giftUsd=25.5;window.memberStatus.gift.amountUsd=7;window.renderMember()")
            expect(page.get_by_role('button', name='领取 $7 平台额度', exact=True)).to_be_enabled()
            expect(page.get_by_label('平台赠送额度').locator('strong')).to_have_text('$7')
            checks.append('An eligible server-reported gift amount takes precedence over the generic campaign amount')

            page.evaluate("window.reset();window.memberStatus.loggedIn=false;window.memberStatus.config.giftEnabled=false;window.memberStatus.config.giftUsd=5;window.renderMember()")
            expect(page.get_by_role('button', name='新客活动暂未开放', exact=True)).to_be_disabled()
            expect(page.get_by_role('button', name='登录并绑定本机', exact=True)).to_be_enabled()
            page.get_by_label('平台会员邮箱', exact=True).fill('fixture@example.invalid')
            page.get_by_label('平台会员密码', exact=True).fill('fixture-password')
            page.get_by_role('button', name='登录并绑定本机', exact=True).click()
            expect(page.get_by_role('button', name='退出会员登录', exact=True)).to_be_enabled()
            expect(page.get_by_role('button', name='新客活动暂未开放', exact=True)).to_be_disabled()
            expect(page.get_by_role('button', name='添加云汇供应商 →', exact=True)).to_be_enabled()
            page.get_by_role('button', name='添加云汇供应商 →', exact=True).click()
            page.wait_for_function("window.destination==='agents' && window.reloads===1")
            assert page.evaluate("window.calls.filter(call=>call.action==='member.login').length") == 1
            assert page.evaluate("window.calls.filter(call=>call.action==='member.addProvider').length") == 1
            assert claim_count() == 0
            checks.append('Closing the gift campaign leaves password login and adding a membership supplier available')

            page.evaluate("window.reset();window.memberStatus.config.giftUsd=20;window.memberStatus.config.giftEnabled=false;window.memberStatus.gift={status:'pending',eligible:false,amountUsd:10};window.renderMember()")
            expect(page.get_by_label('平台赠送额度').locator('strong')).to_have_text('$10')
            expect(page.get_by_text('核对本次 $10', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='重新确认到账', exact=True)).to_be_enabled()
            page.get_by_role('button', name='重新确认到账', exact=True).click()
            expect(page.get_by_role('button', name='新客额度已到账', exact=True)).to_be_disabled()
            expect(page.get_by_label('平台赠送额度').locator('strong')).to_have_text('$10')
            expect(page.get_by_text('已领取 $10', exact=True)).to_be_visible()
            assert claim_count() == 1
            assert page.evaluate("window.calls.find(call=>call.action==='member.claim').payload") == {}
            checks.append('A pending original 10-dollar grant remains confirmable after the campaign changes to 20 and closes, and its confirmed amount stays unchanged')

            for gift_status, button in [('review', '等待人工核对'), ('claimed', '新客额度已到账')]:
                page.evaluate("status=>{window.reset();window.memberStatus.config.giftUsd=25.5;window.memberStatus.gift={status,eligible:false,amountUsd:10};window.renderMember()}", gift_status)
                expect(page.get_by_label('平台赠送额度').locator('strong')).to_have_text('$10')
                expect(page.get_by_role('button', name=button, exact=True)).to_be_disabled()
                assert claim_count() == 0
            checks.append('Review and claimed grants display their recorded amount instead of a later campaign amount')

            for gift_status in ['pending', 'review', 'claimed']:
                page.evaluate("status=>{window.reset();window.memberStatus.config.giftUsd=20;window.memberStatus.gift={status,eligible:false};window.renderMember()}", gift_status)
                expect(page.get_by_label('平台赠送额度').locator('strong')).to_have_text('待确认')
                expect(page.get_by_text('$20', exact=True)).to_have_count(0)
                assert claim_count() == 0
            checks.append('Issued grants without a recorded amount never borrow the current campaign amount')

            page.evaluate("window.reset();delete window.memberStatus.config.giftUsd;delete window.memberStatus.gift.amountUsd;window.renderMember()")
            expect(page.get_by_label('平台赠送额度').locator('strong')).to_have_text('待确认')
            expect(page.get_by_role('button', name='领取额度待确认', exact=True)).to_be_disabled()
            assert '$10' not in page.locator('.member-hero').inner_text()
            page.evaluate("window.reset();window.statusError='离线';window.renderMember()")
            expect(page.get_by_role('alert')).to_contain_text('离线')
            expect(page.get_by_label('平台赠送额度').locator('strong')).to_have_text('待确认')
            expect(page.get_by_role('button', name='请先刷新领取状态', exact=True)).to_be_disabled()
            assert '$10' not in page.locator('.member-hero').inner_text() and '$0' not in page.locator('.member-hero').inner_text()
            page.evaluate("window.reset();window.statusPending=true;window.renderMember()")
            expect(page.get_by_label('平台赠送额度').locator('strong')).to_have_text('待确认')
            expect(page.get_by_role('button', name='请先刷新领取状态', exact=True)).to_be_disabled()
            page.wait_for_function("typeof window.pendingStatus==='function'")
            page.evaluate('window.statusPending=false;window.pendingStatus()')
            ready()
            checks.append('Missing amounts, initial offline status and loading never invent a 10-dollar or zero-dollar campaign')

            page.evaluate("window.reset();window.memberStatus.loggedIn=false;window.memberStatus.config.giftEnabled=false;window.login2fa=true;window.renderMember()")
            expect(page.get_by_role('button', name='登录并绑定本机', exact=True)).to_be_enabled()
            page.get_by_label('平台会员邮箱', exact=True).fill('fixture@example.invalid')
            page.get_by_label('平台会员密码', exact=True).fill('fixture-password')
            page.get_by_role('button', name='登录并绑定本机', exact=True).click()
            expect(page.get_by_label('会员两步验证码', exact=True)).to_be_visible()
            page.get_by_label('会员两步验证码', exact=True).fill('123456')
            page.get_by_role('button', name='验证并绑定', exact=True).first.click()
            expect(page.get_by_role('button', name='退出会员登录', exact=True)).to_be_enabled()
            expect(page.get_by_text('登录状态会自动续期，无需每小时重新登录。', exact=False)).to_be_visible()
            assert page.evaluate("window.calls.filter(call=>call.action==='member.login2fa').length") == 1
            page.get_by_role('button', name='退出会员登录', exact=True).click()
            page.get_by_text('通过平台访问令牌绑定', exact=True).click()
            page.get_by_label('会员访问令牌', exact=True).fill('fixture-manual-token')
            page.get_by_role('button', name='验证并绑定', exact=True).click()
            expect(page.get_by_role('button', name='退出会员登录', exact=True)).to_be_enabled()
            expect(page.get_by_text('当前登录不支持自动续期，访问令牌到期后需要重新绑定。', exact=False)).to_be_visible()
            assert page.evaluate("window.calls.filter(call=>call.action==='member.bind').length") == 1
            assert claim_count() == 0
            checks.append('Closed campaigns retain two-factor login, renewable sessions and explicit manual-token binding')

            for name in ['ui/src/pages/Membership.tsx', 'ui/src/pages/Agents.tsx', 'src/core/presets/providers.ts', 'server/seed-catalog.json']:
                assert '$10' not in (ROOT / name).read_text(encoding='utf-8'), name
            checks.append('Membership, the client banner and both provider catalogs contain no fixed 10-dollar promotion')

            assert not errors, errors
            browser.close()
            for check in checks:
                print('PASS', check)
            print(json.dumps({'ok': True, 'checks': checks, 'browserErrors': errors}, ensure_ascii=False))


if __name__ == '__main__':
    main()
