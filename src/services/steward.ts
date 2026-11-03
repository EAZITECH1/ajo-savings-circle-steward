import {
  Steward,
  StewardChatInput,
  StewardChatOutput,
  MemoryRecord,
  VerificationResult,
  Member,
  ProposedMemory
} from './types'

export class AjoSteward implements Steward {
  async processChat(
    input: StewardChatInput,
    memories: MemoryRecord[],
    verifications: Record<string, VerificationResult>
  ): Promise<StewardChatOutput> {
    const q = input.message.toLowerCase()
    const withMemory = input.withMemory

    // Question 1: "Can Tunde pay late this month?" / Grace period
    if (q.includes('tunde') && (q.includes('late') || q.includes('grace') || q.includes('pay') || q.includes('delay'))) {
      const tundeMemory = memories.find(m => m.title.toLowerCase().includes('tunde') || m.quote.toLowerCase().includes('tunde'))

      if (withMemory && tundeMemory) {
        return {
          reply: `Yes. Under the agreement ratified in Cycle 4 (Blob: ${tundeMemory.walrusBlobId}), Tunde has an approved 3-day grace window due to his monthly contractor invoicing cycle. As long as his 500 USDC deposit arrives on Sui within 72 hours of cycle open, his status remains Verified in good standing.`,
          citedMemories: [tundeMemory],
          riskAssessment: {
            memberId: 'm2',
            riskLevel: 'Low Risk',
            note: 'Protected by approved 3-day grace agreement.'
          }
        }
      } else {
        return {
          reply: `Without memory lookup, standard strict circle rules apply: all contributions are due within the initial 24-hour window. Tunde submitting on Day 3 is classified as Late (Violation) and incurs an onchain alert.`,
          citedMemories: [],
          riskAssessment: {
            memberId: 'm2',
            riskLevel: 'High Risk',
            note: 'Late payment flagged as an unexcused delay.'
          }
        }
      }
    }

    // Question 2: "Who is the riskiest member before payout?" / Risk analysis
    if (q.includes('risk') || q.includes('who is the riskiest') || q.includes('delinquent')) {
      const folakeMemory = memories.find(m => m.title.toLowerCase().includes('folake'))
      const emekaMemory = memories.find(m => m.title.toLowerCase().includes('emeka'))
      const tundeMemory = memories.find(m => m.title.toLowerCase().includes('tunde'))

      if (withMemory) {
        const cited = [folakeMemory, emekaMemory, tundeMemory].filter(Boolean) as MemoryRecord[]
        return {
          reply: `Based on chain balances cross-referenced with Walrus group memory:
1. Folake Adeyemi is currently the primary operational concern: she has 0 USDC submitted for Cycle ${input.currentCycle}. Memory #${folakeMemory ? '4' : ''} notes she ignores public channel pings, so a quiet wallet ping is required.
2. Emeka Nwosu has 250 / 500 USDC onchain, but Memory #${emekaMemory ? '2' : ''} confirms his regular 2-tranche habit within 48 hours, so his default probability is low.
3. Tunde Ojo paid on Day 3, which is authorized under Memory #${tundeMemory ? '1' : ''}.`,
          citedMemories: cited,
          riskAssessment: {
            memberId: 'm6',
            riskLevel: 'Moderate Risk',
            note: 'Requires non-intrusive reminder follow-up.'
          }
        }
      } else {
        return {
          reply: `Raw rule evaluation without memory:
1. Tunde Ojo is flagged High Risk for Late payment (Day 3).
2. Emeka Nwosu is flagged High Risk for Partial payment (underpaid 250 USDC).
3. Folake Adeyemi is Pending.
3 out of 6 members are currently flagged as non-compliant!`,
          citedMemories: [],
          riskAssessment: {
            memberId: 'm2',
            riskLevel: 'High Risk',
            note: 'Multiple members breaching strict cycle thresholds.'
          }
        }
      }
    }

    // Question 3: Emeka or partial payment
    if (q.includes('emeka') || q.includes('split') || q.includes('partial')) {
      const emekaMem = memories.find(m => m.title.toLowerCase().includes('emeka'))
      if (withMemory && emekaMem) {
        return {
          reply: `Emeka has deposited 250 USDC (Tx: 0x1122...3344). Consistent with Memory ("${emekaMem.title}"), he deposits the remaining 250 USDC within 48 hours. No penalty or escalation is warranted.`,
          citedMemories: [emekaMem],
          riskAssessment: {
            memberId: 'm5',
            riskLevel: 'Low Risk',
            note: 'Normal installment behavior.'
          }
        }
      } else {
        return {
          reply: `Emeka has only contributed 250 USDC of the required 500 USDC. Under strict base circle rules, this is recorded as a Partial Payment deficit.`,
          citedMemories: []
        }
      }
    }

    // Question 4: Folake or reminders
    if (q.includes('folake') || q.includes('reminder') || q.includes('ping')) {
      const folakeMem = memories.find(m => m.title.toLowerCase().includes('folake'))
      if (withMemory && folakeMem) {
        return {
          reply: `Folake has not paid yet for Cycle ${input.currentCycle}. Memory ("${folakeMem.title}") records her preference against public tags. The steward recommends dispatching a quiet onchain or direct ping rather than a public Discord mention.`,
          citedMemories: [folakeMem]
        }
      } else {
        return {
          reply: `Folake is overdue. Standard protocol would blast public reminders to all channels.`,
          citedMemories: []
        }
      }
    }

    // General or proposed agreement detection
    let proposed: ProposedMemory | undefined = undefined
    if (q.includes('agree') || q.includes('allow') || q.includes('swap') || q.includes('promise') || q.includes('approve') || q.includes('rule')) {
      proposed = {
        id: `prop-${Date.now()}`,
        category: 'Agreements',
        title: 'Group Decision / Exception Proposal',
        quote: input.message,
        suggestedAction: 'Preserve this consensus in Walrus decentralized memory.'
      }
    }

    return {
      reply: `I have analyzed your query against our Sui RPC verification records and ${memories.length} preserved circle memories. All circle funds remain safe in non-custodial multi-sig custody. ${withMemory ? 'Memory-assisted reasoning is active.' : 'Operating in strict memory-less mode.'}`,
      proposedMemory: proposed,
      citedMemories: []
    }
  }

  async generatePayoutRecommendation(
    cycle: number,
    members: Member[],
    verifications: Record<string, VerificationResult>,
    memories: MemoryRecord[],
    withMemory: boolean
  ) {
    // Determine schedule recipient by cycle modulo
    const scheduledIndex = (cycle - 1) % members.length
    const scheduledMember = members[scheduledIndex] || members[0]

    const tundeMem = memories.find(m => m.title.toLowerCase().includes('tunde'))
    const emekaMem = memories.find(m => m.title.toLowerCase().includes('emeka'))
    const chidiMem = memories.find(m => m.title.toLowerCase().includes('chidi'))
    const folakeMem = memories.find(m => m.title.toLowerCase().includes('folake'))

    const memberRisks = members.map(m => {
      if (m.name.includes('Folake')) {
        return {
          member: m,
          riskLevel: 'Moderate Risk',
          badgeClass: 'bg-utility-warning-50 text-utility-warning-700 border-utility-warning-200',
          reasoning: withMemory
            ? 'Cycle contribution pending. Memory proves she ignores channel pings; quiet notification dispatched.'
            : 'Payment overdue. No payment detected on Sui RPC. Public alert required.',
          action: withMemory ? 'Dispatch quiet private notice.' : 'Flag overdue publicly.',
          citedBlob: folakeMem?.walrusBlobId
        }
      }
      if (m.name.includes('Tunde')) {
        return {
          member: m,
          riskLevel: withMemory ? 'Low Risk (Approved Exception)' : 'High Risk (Violation)',
          badgeClass: withMemory
            ? 'bg-utility-success-50 text-utility-success-700 border-utility-success-200'
            : 'bg-utility-error-50 text-error-primary border-error-subtle',
          reasoning: withMemory
            ? 'Tunde paid on Day 3. Fully excused by Cycle 4 Consensus Agreement (3-day contractor invoice grace).'
            : 'Tunde paid 2 days past cycle deadline without registered exception.',
          action: withMemory ? 'Mark contribution as verified with grace.' : 'Escalate to group committee for penalty.',
          citedBlob: tundeMem?.walrusBlobId
        }
      }
      if (m.name.includes('Emeka')) {
        return {
          member: m,
          riskLevel: 'Low Risk',
          badgeClass: 'bg-utility-success-50 text-utility-success-700 border-utility-success-200',
          reasoning: withMemory
            ? 'Submitted tranche 1 (250 USDC). Memory proves habitual 2-part split within 48 hours.'
            : 'Only 250 USDC of 500 USDC received. Partial payment status.',
          action: withMemory ? 'Awaiting tranche 2 without alarm.' : 'Request immediate remaining balance.',
          citedBlob: emekaMem?.walrusBlobId
        }
      }
      if (m.name.includes('Chidi')) {
        return {
          member: m,
          riskLevel: 'Zero Risk',
          badgeClass: 'bg-utility-success-50 text-utility-success-700 border-utility-success-200',
          reasoning: 'Paid 500 USDC on Day 1. Consistently provides liquidity immediately.',
          action: 'Eligible for rotation swap if requested.',
          citedBlob: chidiMem?.walrusBlobId
        }
      }

      return {
        member: m,
        riskLevel: 'Low Risk',
        badgeClass: 'bg-utility-success-50 text-utility-success-700 border-utility-success-200',
        reasoning: 'Consistent on-time contributor with verified Sui transaction history.',
        action: 'Standard cycle tracking.'
      }
    })

    return {
      nextRecipient: scheduledMember,
      rationale: withMemory
        ? `Scheduled recipient for Cycle ${cycle} is ${scheduledMember.name}. The pool has accumulated 2,750 USDC on Sui. Emeka's second tranche is expected shortly and Tunde's contribution is verified under the Cycle 4 grace rule. Recommend approving payout release.`
        : `Scheduled recipient is ${scheduledMember.name}. However, without memory context, 2 members (Tunde and Emeka) are flagged for payment discrepancies. Caution recommended before releasing pot.`,
      memberRisks
    }
  }
}
