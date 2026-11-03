'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { readOrigin, type DraftOrigin } from '@/lib/broadcasts/drafts';
import { Check, Info } from 'lucide-react';
import { useTranslations } from 'next-intl';

const steps = [
  { label: 'template', key: 'template' },
  { label: 'audience', key: 'audience' },
  { label: 'personalize', key: 'personalize' },
  { label: 'send', key: 'send' },
] as const;

export default function NewBroadcastPage() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.new');
  const { accountId } = useAuth();
  const { createAndSendBroadcast, isProcessing, progress } = useBroadcastSending();

  const [currentStep, setCurrentStep] = useState(0);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<{
    type: 'all' | 'tags' | 'custom_field' | 'csv';
    tagIds?: string[];
    customField?: {
      fieldId: string;
      operator: 'is' | 'is_not' | 'contains';
      value: string;
    };
    csvContacts?: { phone: string; name?: string }[];
    excludeTagIds?: string[];
  }>({ type: 'all' });
  const [variables, setVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [name, setName] = useState('');
  // Opened from a saved draft (/broadcasts/new?draft=<id>) — possibly one
  // another app left through the API: prefill everything, and sending
  // turns that same row into the broadcast.
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftOrigin, setDraftOrigin] = useState<DraftOrigin | null>(null);
  const [missingTemplate, setMissingTemplate] = useState<string | null>(null);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('draft');
    if (!id) return;
    void (async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('broadcasts')
        .select('id, name, status, template_name, template_language, template_variables, audience_filter, origin')
        .eq('id', id)
        .maybeSingle();
      if (error || !data || data.status !== 'draft') {
        toast.error(t('draftLoadFailed'));
        return;
      }
      setDraftId(data.id);
      setName(data.name ?? '');
      setVariables((data.template_variables ?? {}) as typeof variables);
      const filter = (data.audience_filter ?? {}) as { type?: string; tagIds?: string[] };
      if (filter.type === 'tags' && filter.tagIds?.length) setAudience({ type: 'tags', tagIds: filter.tagIds });
      const origin = readOrigin(data.origin);
      setDraftOrigin(origin);
      if (origin?.headerMediaUrl) setHeaderMediaUrl(origin.headerMediaUrl);
      const { data: templates } = await supabase
        .from('message_templates')
        .select('*')
        .eq('name', data.template_name)
        .eq('status', 'APPROVED');
      const list = (templates ?? []) as MessageTemplate[];
      const match = list.find((tpl) => tpl.language === data.template_language) ?? list[0];
      if (match) setTemplate(match);
      else setMissingTemplate(data.template_name);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSend() {
    if (!template) return;

    try {
      const broadcastId = await createAndSendBroadcast({
        name,
        template,
        audience: {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          csvContacts: audience.csvContacts,
          excludeTagIds: audience.excludeTagIds,
        },
        variables,
        headerMediaUrl,
        draftId: draftId ?? undefined,
      });
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      // Previously swallowed with console.error — the wizard would
      // just no-op, leaving the user confused. Surface the reason.
      const message = err instanceof Error ? err.message : 'Broadcast failed';
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }

  /**
   * Writes a draft broadcast row — no recipients, no sending. The user
   * can revisit it via the list page to finish the flow later. We
   * don't persist the in-progress audience/variable config here
   * because the current schema doesn't carry it past `audience_filter`
   * and `template_variables`; those are enough for the user to
   * recognize the draft but not to exactly round-trip into the wizard.
   * A full resume-draft UX is a future polish.
   */
  async function handleSaveDraft() {
    if (!template || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }

    const draft = {
      name: name.trim(),
      template_name: template.name,
      template_language: template.language ?? 'en_US',
      template_variables: variables,
      audience_filter: {
        type: audience.type,
        tagIds: audience.tagIds,
      },
    };
    const { error } = draftId
      ? await supabase
          .from('broadcasts')
          .update({ ...draft, updated_at: new Date().toISOString() })
          .eq('id', draftId)
      : await supabase.from('broadcasts').insert({
          ...draft,
          user_id: user.id,
          account_id: accountId,
          status: 'draft',
          total_recipients: 0,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        });

    if (error) {
      toast.error(t('toastFailedDraft', { error: error.message }));
      return;
    }
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

      {(draftOrigin || missingTemplate) && (
        <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
          {draftOrigin && (
            <>
              <p className="flex items-center gap-2 font-medium text-foreground">
                <Info className="h-4 w-4 text-primary" />
                {t('draftFrom', { source: draftOrigin.source })}
                {draftOrigin.ref && (
                  <span className="font-normal text-muted-foreground">· {t('draftRef', { ref: draftOrigin.ref })}</span>
                )}
              </p>
              {draftOrigin.text && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">{t('draftCopy')}</p>
                  <p className="whitespace-pre-wrap text-foreground">{draftOrigin.text}</p>
                </div>
              )}
              {draftOrigin.note && (
                <p className="text-foreground">
                  <span className="text-xs font-medium text-muted-foreground">{t('draftNote')}: </span>
                  {draftOrigin.note}
                </p>
              )}
              {draftOrigin.suggestedTags.length > 0 && (
                <p className="text-muted-foreground">{t('draftTags', { tags: draftOrigin.suggestedTags.join(', ') })}</p>
              )}
              <p className="text-muted-foreground">{t('draftReview')}</p>
            </>
          )}
          {missingTemplate && (
            <p className="font-medium text-amber-600 dark:text-amber-400">
              {t('draftTemplateMissing', { name: missingTemplate })}
            </p>
          )}
        </div>
      )}

      {/* Step Indicator */}
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <div key={step.key} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-2 border-primary bg-primary/10 text-primary'
                        : 'border border-border bg-muted text-muted-foreground'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    isActive ? 'text-foreground' : isCompleted ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {t(`steps.${step.label}`)}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`mx-3 h-px flex-1 ${
                    index < currentStep ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="relative min-h-[400px]">
        <div
          className="transition-all duration-300 ease-in-out"
          style={{
            opacity: isProcessing ? 0.6 : 1,
            pointerEvents: isProcessing ? 'none' : 'auto',
          }}
        >
          {currentStep === 0 && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              onSelect={setTemplate}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {currentStep === 1 && (
            <Step2SelectAudience
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(2)}
              onBack={() => setCurrentStep(0)}
            />
          )}
          {currentStep === 2 && template && (
            <Step3Personalize
              template={template}
              variables={variables}
              onUpdate={setVariables}
              headerMediaUrl={headerMediaUrl}
              onHeaderMediaUrlChange={setHeaderMediaUrl}
              onNext={() => setCurrentStep(3)}
              onBack={() => setCurrentStep(1)}
            />
          )}
          {currentStep === 3 && template && (
            <Step4ScheduleSend
              name={name}
              onNameChange={setName}
              template={template}
              audience={audience}
              onSend={handleSend}
              onSaveDraft={handleSaveDraft}
              onBack={() => setCurrentStep(2)}
              isProcessing={isProcessing}
              progress={progress}
            />
          )}
        </div>
      </div>
    </div>
  );
}
