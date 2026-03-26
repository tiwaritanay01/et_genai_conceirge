import { Injectable, signal, inject } from '@angular/core';
import { ChatMessage, InsightCard, XSellItem, RecommendationChip, ActionItem, AgentType } from '../models';
import { GeminiService } from './gemini.service';
import { MarketService } from './market.service';
import { UserProfileService } from './user-profile.service';
import { PortfolioService } from './portfolio.service';

@Injectable({ providedIn: 'root' })
export class ChatService {

  // ── Injected agents ────────────────────────────────────────────────────────
  private gemini    = inject(GeminiService);
  private market    = inject(MarketService);
  private userSvc   = inject(UserProfileService);
  private portfolio = inject(PortfolioService);

  // ── State ──────────────────────────────────────────────────────────────────
  readonly messages    = signal<ChatMessage[]>([]);
  readonly isTyping    = signal<boolean>(false);
  readonly activeMode  = signal<'Navigator' | 'Markets' | 'Services' | 'Goals'>('Navigator');
  readonly activeAgent = signal<AgentType>('navigator');
  readonly interruptPending = signal<boolean>(false);

  readonly quickPrompts = [
    'Show my portfolio snapshot',
    'How do I close my retirement gap?',
    'Best tax-saving options for FY26',
    'Compare home loan rates',
    'What events should I attend?',
  ];

  private msgCounter = 0;
  private mkId(): string { return `msg-${++this.msgCounter}`; }

  // ── Gemini system prompt ───────────────────────────────────────────────────
  private buildSystemPrompt(): string {
    return `You are the ET Concierge — a premium agentic AI financial intelligence layer for Economic Times, India's leading financial media platform.

USER PROFILE:
${this.userSvc.buildContextSummary()}

MARKET CONTEXT:
${this.market.getMarketContext()}

YOUR 4 AGENT ROLES:
1. Profiling Agent — builds user financial identity, personalises all responses
2. Navigator Agent — delivers data-rich financial briefings, references live ET Markets data
3. Opportunity Agent — surfaces contextual cross-sell (ET Prime, ET Markets, ET Financial Services, ET Events)
4. Fulfilment Agent — simulates completing actions (applying, registering, initiating SIPs)

ET ECOSYSTEM YOU REPRESENT:
- ET Prime (premium content), ET Markets (stocks, MFs, portfolio), ET Masterclasses (education)
- ET Wealth Summit & Events, ET Financial Services (credit cards, loans, insurance, wealth mgmt via HDFC, Axis, Mirae Asset, Motilal Oswal)

RESPONSE RULES:
- Be precise, data-rich, Bloomberg-terminal meets private-banker energy
- Always use ₹ for Indian Rupee. Give specific numbers, fund names, rates
- Keep responses under 80 words — concise but punchy
- Naturally mention relevant ET products/services when they fit (not forced)
- **CRITICAL**: Always end your response with a clear question or a choice for the user to make (e.g. "Should we look at X or Y first?")
- **FORMATTING**: Use markdown bolding for numbers and key terms. Use bullet points for scannability.
- Never say "I'm an AI" or "as a language model"`;
  }

  // ── Initialise with Navigator Agent briefing ───────────────────────────────
  constructor() {
    setTimeout(() => this.loadInitialMessages(), 300);
  }

  private loadInitialMessages(): void {
    const greetingInsights: InsightCard[] = [
      { label: 'Portfolio Value',     value: '₹62.4L',  sub: '+5.2% this month',    color: 'gold',  action: 'portfolio' },
      { label: 'Retirement Gap',      value: '₹29L',    sub: 'vs ₹3.2Cr target',    color: 'red',   action: 'gap'       },
      { label: 'Matched Ops Today',   value: '4 found', sub: 'Cards, loans, events', color: 'blue',  action: 'opps'      },
      { label: 'Discovery Score',     value: '68/100',  sub: '+15 pts available',    color: 'green', action: 'discovery' },
    ];

    const xsellItems: XSellItem[] = [
      { icon: '💳', title: 'Axis Ace Card — Pre-approved for you',    subtitle: 'CIBIL 786 · 2% cashback · No hard inquiry',   prompt: 'Tell me about Axis Ace credit card pre-approval', tag: 'SERVICE' },
      { icon: '📅', title: 'ET Wealth Summit — Mar 28 (3 days away)', subtitle: 'Nilesh Shah keynote · Included in Prime plan', prompt: 'Register me for ET Wealth Summit',                tag: 'EVENT'   },
    ];

    const chips: RecommendationChip[] = [
      { label: '📉 Fix my Retirement Gap', highlight: true,  prompt: 'How do I close my retirement gap?' },
      { label: '💸 Optimize FY26 Tax', highlight: false, prompt: 'Show me my tax saving plan for FY26' },
      { label: '💎 View ET Markets Picks', highlight: false, prompt: 'Give me ET Markets top mutual fund picks' },
      { label: '🛡️ Check Insurance Gaps', highlight: false, prompt: 'Do an insurance audit for me' },
    ];

    this.messages.set([
      {
        id:       this.mkId(),
        role:     'ai',
        agent:    'navigator',
        timestamp: new Date(),
        text:     `Good morning, <strong class="text-gold">Durgesh </strong>. Markets are up — NIFTY +0.74%. Your portfolio outperformed by 1.2% this month. The most urgent item is a <strong class="text-red">₹29L retirement gap</strong> that needs a strategy shift. **Should we start there, or would you like to see your tax-saving picks for FY26 first?**`,
        insights: greetingInsights,
        chips,
      },
      {
        id:        this.mkId(),
        role:      'ai',
        agent:     'opportunity',
        timestamp: new Date(),
        text:      `<strong class="text-gold">Opportunity Agent</strong> → I've flagged two urgent items: Your legacy LIC policy is underperforming compared to the market, and there's an ET Wealth Summit happening in 3 days that covers exactly your portfolio needs. **Want the details?**`,
        xsellItems,
      },
    ]);
  }

  // ── Main send ──────────────────────────────────────────────────────────────
  async sendMessage(text: string): Promise<void> {
    if (!text.trim()) return;

    // Add user message
    this.messages.update(msgs => [
      ...msgs,
      { id: this.mkId(), role: 'user', timestamp: new Date(), text },
    ]);

    // ── Opportunity Agent: keyword interrupt check ──────────────────────────
    const opportunityMatch = this.portfolio.getOpportunityByKeyword(text);
    const lastMsgs = this.messages();
    const alreadyInterrupted = lastMsgs
      .slice(-6)
      .some(m => m.interrupt && m.xsellItems?.some(x => opportunityMatch && x.title.toLowerCase().includes(opportunityMatch.name.toLowerCase().slice(0, 10))));

    if (opportunityMatch && !alreadyInterrupted) {
      await this.delay(600);
      this.injectOpportunityInterrupt(opportunityMatch);
    }

    // ── Navigator Agent: main response ────────────────────────────────────
    this.isTyping.set(true);
    this.activeAgent.set('navigator');

    let reply: ChatMessage;

    // Try Gemini first (free API)
    const geminiHistory = this.gemini.buildHistory(
      this.messages().slice(-12).map(m => ({ role: m.role, text: m.text }))
    );
    const geminiResponse = await this.gemini.chat(
      this.buildSystemPrompt(),
      geminiHistory,
      text
    );

    if (geminiResponse) {
      // Gemini responded — wrap it with chips
      reply = this.wrapGeminiResponse(geminiResponse, text);
    } else {
      // Local engine fallback
      reply = this.localEngine(text);
    }

    await this.delay(800 + Math.random() * 600);
    this.isTyping.set(false);
    this.messages.update(msgs => [...msgs, reply]);

    // ── Fulfilment Agent: action offer after certain intents ───────────────
    if (this.shouldOfferAction(text)) {
      await this.delay(1200);
      this.injectFulfilmentAction(text);
    }
  }

  // ── Opportunity Agent interrupt (proactive, unsolicited) ──────────────────
  private injectOpportunityInterrupt(opp: ReturnType<typeof this.portfolio.getOpportunityByKeyword>): void {
    if (!opp) return;
    this.activeAgent.set('opportunity');
    const msg: ChatMessage = {
      id:        this.mkId(),
      role:      'ai',
      agent:     'opportunity',
      interrupt: true,
      timestamp: new Date(),
      text:      `<strong class="text-gold">Opportunity Agent →</strong> This matches your profile perfectly. **Should I add this to your plan?**`,
      xsellItems: [{
        icon:     opp.tag === 'event' ? '📅' : opp.tag === 'market' ? '📊' : '💡',
        title:    opp.name,
        subtitle: opp.description,
        prompt:   opp.prompt,
        tag:      opp.tag.toUpperCase(),
      }],
    };
    this.messages.update(msgs => [...msgs, msg]);
  }

  // ── Fulfilment Agent action injection ─────────────────────────────────────
  private shouldOfferAction(text: string): boolean {
    const t = text.toLowerCase();
    return ['apply', 'register', 'invest', 'start sip', 'open', 'book', 'enrol', 'increase sip'].some(kw => t.includes(kw));
  }

  private injectFulfilmentAction(trigger: string): void {
    this.activeAgent.set('fulfilment');
    const t = trigger.toLowerCase();

    let actions: ActionItem[] = [];

    if (t.includes('sip') || t.includes('invest') || t.includes('fund')) {
      actions = [
        { label: 'Draft SIP mandate (₹5,000/mo → Parag Parikh)',  icon: '📝', prompt: 'Confirm SIP increase',        done: false },
        { label: 'Link bank account for auto-debit',              icon: '🏦', prompt: 'Link bank account for SIP',   done: false },
        { label: 'Set goal tracker for retirement corpus',        icon: '🎯', prompt: 'Set retirement goal tracker', done: false },
      ];
    } else if (t.includes('apply') || t.includes('card') || t.includes('credit')) {
      actions = [
        { label: 'Pre-fill Axis Ace application (KYC complete)', icon: '✅', prompt: 'Submit credit card application', done: false },
        { label: 'Soft-pull CIBIL check (no score impact)',      icon: '📊', prompt: 'Run soft CIBIL check',          done: false },
      ];
    } else if (t.includes('register') || t.includes('event') || t.includes('summit')) {
      actions = [
        { label: 'Register for ET Wealth Summit (Mar 28)',      icon: '🎟️', prompt: 'Confirm Summit registration',  done: false },
        { label: 'Add to Google Calendar',                      icon: '📅', prompt: 'Add summit to calendar',       done: false },
      ];
    } else if (t.includes('loan') || t.includes('home')) {
      actions = [
        { label: 'Generate in-principle approval letter (HDFC)', icon: '📄', prompt: 'Generate loan approval letter', done: false },
        { label: 'Schedule call with HDFC relationship manager', icon: '📞', prompt: 'Schedule HDFC RM call',         done: false },
      ];
    }

    if (actions.length === 0) return;

    const msg: ChatMessage = {
      id:        this.mkId(),
      role:      'ai',
      agent:     'fulfilment',
      timestamp: new Date(),
      text:      `<strong class="text-gold">Fulfilment Agent →</strong> I can execute these steps for you right now:`,
      actions,
    };
    this.messages.update(msgs => [...msgs, msg]);
  }

  // ── Wrap Gemini response with contextual chips ─────────────────────────────
  private wrapGeminiResponse(text: string, trigger: string): ChatMessage {
    const chips = this.getContextualChips(trigger);
    return {
      id:        this.mkId(),
      role:      'ai',
      agent:     'navigator',
      timestamp: new Date(),
      text,
      chips,
    };
  }

  // ── Local engine — rich fallback (no API needed) ───────────────────────────
  private localEngine(input: string): ChatMessage {
    const t = input.toLowerCase();
    let text: string;
    let chips: RecommendationChip[] | undefined;
    let insights: InsightCard[] | undefined;

    if (t.includes('portfolio') || t.includes('net worth') || t.includes('allocation') || t.includes('holding')) {
      text = `Your **₹62.4L net worth** is spread across 4 asset classes:
- **Equity MFs**: Leading at +2.4% MoM.
- **Legacy LIC**: Real return of 4.2% — this is "dead weight".
I recommend surrendering the LIC policy and redirecting to a High-Growth Flexi Cap. **Should we run a comparison against NIFTY 50 first?**`;
      insights = [
        { label: 'Equity MFs',    value: '₹34.3L', sub: '+2.4% this month', color: 'gold',  action: 'equity' },
        { label: 'Direct Stocks', value: '₹11.2L', sub: '+1.8% this month', color: 'blue',  action: 'stocks' },
        { label: 'FD / Debt',     value: '₹9.4L',  sub: '+0.6% (FD rate)',  color: 'green', action: 'debt'   },
        { label: 'Gold / RE',     value: '₹7.5L',  sub: '+0.3% this month', color: 'gold',  action: 'gold'   },
      ];
      chips = [
        { label: 'Surrender LIC & reinvest',  highlight: true,  prompt: 'Should I surrender my LIC endowment and reinvest?' },
        { label: 'Compare to NIFTY',          highlight: false, prompt: 'How does my portfolio compare to NIFTY 50 returns?' },
        { label: 'Rebalancing strategy',      highlight: false, prompt: 'Give me a rebalancing strategy for my portfolio' },
      ];

    } else if (t.includes('retirement') || t.includes('retire') || t.includes('corpus') || t.includes('gap')) {
      text = `Retirement goal: **₹3.2 Cr by 2037**. Current gap: **₹29L**.
Three key levers:
- **SIP Step-up**: +₹5K/mo closes 60% of gap.
- **NPS Top-up**: Closes another 25%.
- **Mid-cap Tilt**: Targeted alpha generation.
**Which lever should we pull first to secure your 2037 target?**`;
      chips = [
        { label: '↑ SIP by ₹5K/month',   highlight: true,  prompt: 'How do I increase my SIP by 5000 per month to a new fund?' },
        { label: 'Open NPS account',      highlight: false, prompt: 'How does NPS help close my retirement gap?' },
        { label: 'Mid-cap rebalance',     highlight: false, prompt: 'Which mid-cap funds should I add for retirement?' },
        { label: 'Full projection view',  highlight: false, prompt: 'Show me my retirement corpus projection year by year' },
      ];

    } else if (t.includes('tax') || t.includes('80c') || t.includes('elss') || t.includes('deduction') || t.includes('fy26') || t.includes('fy 26')) {
      text = `FY26 Tax Snapshot: **₹88,500 of 80C unused**.
- **Max 80C**: Save ₹24,000 in tax.
- **NPS 80CCD**: Save an extra ₹15,600.
Best ELSS: **Quant Tax Plan** (30.2% 3Y CAGR).
**Would you like me to create a complete FY26 tax saving roadmap for you?**`;
      chips = [
        { label: 'Invest in Quant Tax Plan', highlight: true,  prompt: 'How do I invest in Quant Tax Plan ELSS?' },
        { label: 'Open NPS for 80CCD',       highlight: false, prompt: 'How much tax do I save with NPS 80CCD 1B?' },
        { label: 'HRA optimisation',         highlight: false, prompt: 'How can I optimise my HRA claim?' },
        { label: 'Full FY26 tax plan',       highlight: false, prompt: 'Create a complete FY26 tax saving plan for me' },
      ];

    } else if (t.includes('nps') || t.includes('national pension')) {
      text = 'NPS: <strong class="text-gold">₹1.5L under 80C + ₹50K extra 80CCD(1B)</strong>. At your 30% bracket, that\'s ₹15,600 tax saved annually. 60% of corpus tax-free at maturity. Tier I lock-in until 60. Best allocation: 75% equity (Tier I) now, shift to hybrid after 50.';
      chips = [
        { label: 'Open NPS (HDFC Pension)', highlight: true,  prompt: 'How to open NPS account with HDFC Pension?' },
        { label: 'NPS vs ELSS vs PPF',      highlight: false, prompt: 'Compare NPS ELSS and PPF for my profile' },
      ];

    } else if (t.includes('sip') || t.includes('systematic investment')) {
      text = 'Current SIPs: ₹25,000/month across 3 funds. To close retirement gap, add <strong class="text-gold">Parag Parikh Flexi Cap at ₹5,000/month</strong> — 18.4% 5Y CAGR, global diversification, zero overlap with existing holdings. Returns projection: ₹8.7L in 7 years.';
      chips = [
        { label: 'Start Parag Parikh SIP',  highlight: true,  prompt: 'Start SIP in Parag Parikh Flexi Cap fund for 5000 per month' },
        { label: 'Compare flexi-cap funds', highlight: false, prompt: 'Compare top flexi cap mutual funds India 2025' },
        { label: 'SIP projection calc',     highlight: false, prompt: 'Calculate my SIP corpus at 15 percent for 10 years' },
      ];

    } else if (t.includes('credit card') || t.includes('axis ace') || t.includes('cashback card')) {
      text = 'Pre-approved via ET: <strong class="text-gold">Axis Ace (CIBIL 786 → instant)</strong>. 2% flat cashback, ₹500 Amazon voucher on activation, no first-year fee, no hard pull on credit report. Limit likely ₹3–5L based on income. Second best: HDFC Regalia (lounge + rewards).';
      chips = [
        { label: 'Apply Axis Ace (no hard pull)', highlight: true,  prompt: 'Apply for Axis Ace credit card via ET now' },
        { label: 'Compare all matched cards',     highlight: false, prompt: 'Show all 4 credit cards matched to my profile' },
        { label: 'HDFC Regalia alternative',      highlight: false, prompt: 'Tell me about HDFC Regalia credit card benefits' },
      ];

    } else if (t.includes('home loan') || t.includes('housing loan') || t.includes('property loan') || t.includes('home purchase')) {
      text = 'ET pre-negotiated HDFC rate: <strong class="text-gold">8.35%</strong> (market: 8.65%). On ₹60L / 20 years → EMI ₹51,800, interest saving vs market rate = <strong class="text-green">₹2.8L over tenure</strong>. Your salary-to-EMI ratio is healthy at 28.7%. In-principle approval: instant.';
      chips = [
        { label: 'Get in-principle letter (HDFC)', highlight: true,  prompt: 'Generate HDFC home loan in principle approval letter' },
        { label: 'Compare all lenders',            highlight: false, prompt: 'Compare home loan rates SBI HDFC ICICI Kotak 2025' },
        { label: 'EMI stress test',                highlight: false, prompt: 'What if interest rates rise to 9.5 percent on my loan?' },
      ];

    } else if (t.includes('insurance') || t.includes('term plan') || t.includes('life cover') || t.includes('health cover')) {
      text = 'Gaps detected: <strong class="text-red">Life cover ₹25L (need ₹1.8Cr at 10x income)</strong>, health cover ₹3L employer (need ₹10L family floater). Best term: HDFC Click2Protect ₹1Cr at ₹14,200/year. Best health: Star Comprehensive at ₹18,000/year, OPD included.';
      chips = [
        { label: 'Get ₹1Cr term cover',   highlight: true,  prompt: 'Apply for HDFC Click2Protect 1 crore term plan' },
        { label: 'Get ₹10L health cover', highlight: false, prompt: 'Apply for Star Health 10 lakh family floater' },
        { label: 'Full insurance audit',  highlight: false, prompt: 'Do a complete insurance needs analysis for me' },
      ];

    } else if (t.includes('gold') || t.includes('sgb') || t.includes('sovereign')) {
      text = 'Gold at <strong class="text-gold">₹72,410/10g (+0.3% today)</strong>. Your 12% gold allocation is slightly high — optimal is 8–10%. Sovereign Gold Bonds (SGB) give gold returns + 2.5% annual interest, tax-free on maturity. Next SGB tranche: April 2025.';
      chips = [
        { label: 'Invest in next SGB tranche', highlight: true,  prompt: 'How to invest in Sovereign Gold Bonds next tranche?' },
        { label: 'Gold ETF vs SGB',            highlight: false, prompt: 'Compare Gold ETF and SGB returns and tax treatment' },
      ];

    } else if (t.includes('fd') || t.includes('fixed deposit') || t.includes('fixed income')) {
      text = 'Your FD at <strong class="text-red">6.8%</strong> is losing to inflation (6.1% CPI = 0.7% real return). Unity SFB offers <strong class="text-gold">9.1%</strong> (DICGC insured up to ₹5L). For amounts above ₹5L, Bharat Bond ETF (7.5% sovereign-backed) is more tax-efficient.';
      chips = [
        { label: 'Switch to Unity SFB 9.1%', highlight: true,  prompt: 'How to open Unity Small Finance Bank FD safely?' },
        { label: 'Bharat Bond ETF',          highlight: false, prompt: 'Tell me about Bharat Bond ETF as FD alternative' },
      ];

    } else if (t.includes('et prime') || t.includes('prime content') || t.includes('what is new')) {
      text = 'On <strong class="text-gold">ET Prime Wealth today</strong>: "RBI rate hold — FD strategy for 2025", "Budget ELSS impact deep dive", and an exclusive Motilal Oswal CIO webinar on Thursday. Your unread queue: 7 articles matched to your wealth-building goal.';
      chips = [
        { label: 'Read RBI FD strategy',  highlight: true,  prompt: 'Tell me key points from the RBI rate hold article on ET Prime' },
        { label: 'Thursday webinar',      highlight: false, prompt: 'How do I register for Motilal Oswal CIO webinar?' },
        { label: 'My matched articles',   highlight: false, prompt: 'Show me ET Prime articles matched to my profile today' },
      ];

    } else if (t.includes('event') || t.includes('summit') || t.includes('masterclass') || t.includes('webinar')) {
      text = 'Two events matched: <strong class="text-gold">ET Wealth Summit (Mar 28)</strong> — Nilesh Shah + Prashant Jain keynoting, included in your Prime plan. And <strong class="text-gold">ET Masterclass: Portfolio for the 30s</strong> — 2 seats left, ₹999 (free with Wealth tier).';
      chips = [
        { label: 'Register for ET Summit',    highlight: true,  prompt: 'Register me for ET Wealth Summit on March 28' },
        { label: 'Enrol in Masterclass',      highlight: false, prompt: 'Enrol me in ET Portfolio Masterclass for the 30s' },
        { label: 'All upcoming ET events',    highlight: false, prompt: 'Show all upcoming ET events webinars and masterclasses' },
      ];

    } else if (t.includes('discovery') || t.includes('score') || t.includes('unlock') || t.includes('how to improve')) {
      text = 'Discovery Score: <strong class="text-gold">68/100</strong>. Unlock 32 more pts: sync portfolio via ET Markets (+10), activate one financial service (+8), attend ET event (+7), complete a masterclass (+7). At 85+, you unlock the ET Wealth dedicated RM service.';
      chips = [
        { label: 'Sync portfolio (+10 pts)',   highlight: true,  prompt: 'How do I sync my portfolio with ET Markets?' },
        { label: 'Activate a service (+8 pts)', highlight: false, prompt: 'Which financial service should I activate first?' },
        { label: 'Unlock ET Wealth RM',        highlight: false, prompt: 'What does the ET Wealth dedicated RM service offer?' },
      ];

    } else if (t.includes('hello') || t.includes('hi ') || t.includes('good morning') || t.includes('hey') || t.match(/^hi$/i)) {
      text = `Good to have you back, <strong class="text-gold">Durgesh </strong>. NIFTY is up today — your portfolio outperformed. You have 4 matched opportunities and the ET Wealth Summit is in 3 days. Your retirement gap is the priority action this week. Where shall we start?`;
      chips = [
        { label: 'Portfolio snapshot',       highlight: false, prompt: 'Show me my full portfolio snapshot' },
        { label: 'Close retirement gap',     highlight: true,  prompt: 'How do I close my retirement gap of 29 lakhs?' },
        { label: 'My matched opportunities', highlight: false, prompt: 'Show me all 4 opportunities matched to me today' },
      ];

    } else {
      text = `Based on your **Wealth profile**, the priority action is addressing your **₹29L retirement gap**. 
I can also:
- Surface **ET Markets** top picks.
- Optimize **FY26 Tax** (₹88.5K remaining).
- Explore **ET Masterclasses**.
**Where should we focus our strategy today?**`;
      chips = [
        { label: '🚀 Fix Retirement Gap', highlight: true,  prompt: 'What is the fastest way to close my retirement gap?' },
        { label: '📈 ET Markets Picks',  highlight: false, prompt: 'Show me ET Markets top mutual fund picks for my profile' },
        { label: '💰 Tax Optimization',  highlight: false, prompt: 'How can I save maximum tax for FY26?' },
      ];
    }

    return {
      id:        this.mkId(),
      role:      'ai',
      agent:     'navigator',
      timestamp: new Date(),
      text,
      insights,
      chips,
    };
  }

  // ── Contextual chips for Gemini responses ─────────────────────────────────
  private getContextualChips(trigger: string): RecommendationChip[] {
    const t = trigger.toLowerCase();
    if (t.includes('sip') || t.includes('fund') || t.includes('invest')) {
      return [
        { label: 'Start this SIP now',      highlight: true,  prompt: 'Start the recommended SIP now' },
        { label: 'Compare alternatives',    highlight: false, prompt: 'Show me alternative fund options' },
      ];
    }
    if (t.includes('tax') || t.includes('80c')) {
      return [
        { label: 'Invest in ELSS now',      highlight: true,  prompt: 'Which ELSS fund should I invest in right now?' },
        { label: 'Maximise NPS deduction',  highlight: false, prompt: 'How to maximise NPS tax deduction?' },
      ];
    }
    if (t.includes('loan') || t.includes('home')) {
      return [
        { label: 'Get in-principle letter', highlight: true,  prompt: 'Generate home loan in principle approval' },
        { label: 'Compare lenders',         highlight: false, prompt: 'Compare home loan rates across all banks' },
      ];
    }
    return [
      { label: 'Tell me more',         highlight: false, prompt: `Tell me more about: ${trigger.slice(0, 50)}` },
      { label: 'Related opportunities', highlight: false, prompt: 'What ET opportunities relate to this?' },
    ];
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  setMode(mode: 'Navigator' | 'Markets' | 'Services' | 'Goals'): void {
    this.activeMode.set(mode);

    const modePrompts: Record<string, string> = {
      Markets:  'Switch to Markets mode — show me my ET Markets watchlist and top picks today',
      Services: 'Switch to Services mode — show me all ET financial services matched to my profile',
      Goals:    'Switch to Goals mode — show me all my financial goals and progress',
    };
    if (modePrompts[mode]) {
      this.sendMessage(modePrompts[mode]);
    }
  }

  // Fulfilment Agent: simulate completing an action
  markActionDone(msgId: string, actionLabel: string): void {
    this.messages.update(msgs =>
      msgs.map(m => {
        if (m.id !== msgId || !m.actions) return m;
        return {
          ...m,
          actions: m.actions.map(a =>
            a.label === actionLabel ? { ...a, done: true } : a
          ),
        };
      })
    );

    // Confirmation message from fulfilment agent
    setTimeout(() => {
      this.messages.update(msgs => [
        ...msgs,
        {
          id:        this.mkId(),
          role:      'ai',
          agent:     'fulfilment',
          timestamp: new Date(),
          text:      `<strong class="text-green">✓ Done —</strong> "${actionLabel.slice(0, 50)}" has been executed. Discovery Score updated. What's next?`,
          chips: [
            { label: 'Continue →', highlight: true,  prompt: 'What should I do next based on my profile?' },
            { label: 'View all actions', highlight: false, prompt: 'Show me all pending actions in my financial plan' },
          ],
        },
      ]);
    }, 600);
  }
}
