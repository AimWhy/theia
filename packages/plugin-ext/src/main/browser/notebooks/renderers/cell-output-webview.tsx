// *****************************************************************************
// Copyright (C) 2023 TypeFox and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from '@theia/core/shared/react';
import { inject, injectable, interfaces, postConstruct } from '@theia/core/shared/inversify';
import { generateUuid } from '@theia/core/lib/common/uuid';
import {
    NotebookRendererMessagingService, CellOutputWebview, NotebookRendererRegistry,
    NotebookEditorWidgetService, NotebookCellOutputsSplice, NOTEBOOK_EDITOR_ID_PREFIX, NotebookKernelService, NotebookEditorWidget
} from '@theia/notebook/lib/browser';
import { NotebookCellModel } from '@theia/notebook/lib/browser/view-model/notebook-cell-model';
import { WebviewWidget } from '../../webview/webview';
import { Message, WidgetManager } from '@theia/core/lib/browser';
import { outputWebviewPreload, PreloadContext } from './output-webview-internal';
import { WorkspaceTrustService } from '@theia/workspace/lib/browser';
import { ChangePreferredMimetypeMessage, FromWebviewMessage, OutputChangedMessage } from './webview-communication';
import { CellUri } from '@theia/notebook/lib/common';
import { Disposable, DisposableCollection, nls, QuickPickService } from '@theia/core';
import { NotebookCellOutputModel } from '@theia/notebook/lib/browser/view-model/notebook-cell-output-model';
import { NotebookModel } from '@theia/notebook/lib/browser/view-model/notebook-model';

const CellModel = Symbol('CellModel');
const Notebook = Symbol('NotebookModel');

export function createCellOutputWebviewContainer(ctx: interfaces.Container, cell: NotebookCellModel, notebook: NotebookModel): interfaces.Container {
    const child = ctx.createChild();
    child.bind(CellModel).toConstantValue(cell);
    child.bind(Notebook).toConstantValue(notebook);
    child.bind(CellOutputWebviewImpl).toSelf().inSingletonScope();
    return child;
}

@injectable()
export class CellOutputWebviewImpl implements CellOutputWebview, Disposable {

    @inject(NotebookRendererMessagingService)
    protected readonly messagingService: NotebookRendererMessagingService;

    @inject(CellModel)
    protected readonly cell: NotebookCellModel;

    @inject(Notebook)
    protected readonly notebook: NotebookModel;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(WorkspaceTrustService)
    protected readonly workspaceTrustService: WorkspaceTrustService;

    @inject(NotebookRendererRegistry)
    protected readonly notebookRendererRegistry: NotebookRendererRegistry;

    @inject(NotebookEditorWidgetService)
    protected readonly notebookEditorWidgetService: NotebookEditorWidgetService;

    @inject(NotebookKernelService)
    protected readonly notebookKernelService: NotebookKernelService;

    @inject(QuickPickService)
    protected readonly quickPickService: QuickPickService;

    readonly id = generateUuid();

    protected editor: NotebookEditorWidget | undefined;

    protected readonly elementRef = React.createRef<HTMLDivElement>();
    protected outputPresentationListeners: DisposableCollection = new DisposableCollection();

    protected webviewWidget: WebviewWidget;

    protected toDispose = new DisposableCollection();

    @postConstruct()
    protected async init(): Promise<void> {
        this.editor = this.notebookEditorWidgetService.getNotebookEditor(NOTEBOOK_EDITOR_ID_PREFIX + CellUri.parse(this.cell.uri)?.notebook);

        this.toDispose.push(this.cell.onDidChangeOutputs(outputChange => this.updateOutput(outputChange)));
        this.toDispose.push(this.cell.onDidChangeOutputItems(output => {
            this.updateOutput({ start: this.cell.outputs.findIndex(o => o.outputId === output.outputId), deleteCount: 1, newOutputs: [output] });
        }));

        if (this.editor) {
            this.toDispose.push(this.editor.onDidPostKernelMessage(message => {
                this.webviewWidget.sendMessage({
                    type: 'customKernelMessage',
                    message
                });
            }));

            this.toDispose.push(this.editor.onPostRendererMessage(messageObj => {
                this.webviewWidget.sendMessage({
                    type: 'customRendererMessage',
                    ...messageObj
                });
            }));

        }

        this.webviewWidget = await this.widgetManager.getOrCreateWidget(WebviewWidget.FACTORY_ID, { id: this.id });
        this.webviewWidget.setContentOptions({ allowScripts: true });
        this.webviewWidget.setHTML(await this.createWebviewContent());

        this.webviewWidget.onMessage((message: FromWebviewMessage) => {
            this.handleWebviewMessage(message);
        });
    }

    render(): React.JSX.Element {
        return <div className='theia-notebook-cell-output-webview' ref={this.elementRef}></div>;
    }

    attachWebview(): void {
        if (this.elementRef.current) {
            this.webviewWidget.processMessage(new Message('before-attach'));
            this.elementRef.current.appendChild(this.webviewWidget.node);
            this.webviewWidget.processMessage(new Message('after-attach'));
            this.webviewWidget.setIframeHeight(0);
        }
    }

    isAttached(): boolean {
        return this.elementRef.current?.contains(this.webviewWidget.node) ?? false;
    }

    updateOutput(update: NotebookCellOutputsSplice): void {
        if (this.webviewWidget.isHidden) {
            this.webviewWidget.show();
        }

        this.outputPresentationListeners.dispose();
        this.outputPresentationListeners = new DisposableCollection();
        for (const output of this.cell.outputs) {
            this.outputPresentationListeners.push(output.onRequestOutputPresentationChange(() => this.requestOutputPresentationUpdate(output)));
        }

        const updateOutputMessage: OutputChangedMessage = {
            type: 'outputChanged',
            newOutputs: update.newOutputs.map(output => ({
                id: output.outputId,
                items: output.outputs.map(item => ({ mime: item.mime, data: item.data.buffer })),
                metadata: output.metadata
            })),
            deleteStart: update.start,
            deleteCount: update.deleteCount
        };

        this.webviewWidget.sendMessage(updateOutputMessage);
    }

    private async requestOutputPresentationUpdate(output: NotebookCellOutputModel): Promise<void> {
        const selectedMime = await this.quickPickService.show(
            output.outputs.map(item => ({ label: item.mime })),
            { description: nls.localizeByDefault('Select mimetype to render for current output') });
        if (selectedMime) {
            this.webviewWidget.sendMessage({
                type: 'changePreferredMimetype',
                outputId: output.outputId,
                mimeType: selectedMime.label
            } as ChangePreferredMimetypeMessage);
        }
    }

    private handleWebviewMessage(message: FromWebviewMessage): void {
        if (!this.editor) {
            throw new Error('No editor found for cell output webview');
        }

        switch (message.type) {
            case 'initialized':
                this.updateOutput({ newOutputs: this.cell.outputs, start: 0, deleteCount: 0 });
                break;
            case 'customRendererMessage':
                this.messagingService.getScoped(this.editor.id).postMessage(message.rendererId, message.message);
                break;
            case 'didRenderOutput':
                this.webviewWidget.setIframeHeight(message.contentHeight + 5);
                break;
            case 'did-scroll-wheel':
                this.editor.node.children[0].children[1].scrollBy(message.deltaX, message.deltaY);
                break;
            case 'customKernelMessage':
                this.editor.recieveKernelMessage(message.message);
                break;
        }
    }

    getPreloads(): string[] {
        const kernel = this.notebookKernelService.getSelectedOrSuggestedKernel(this.notebook);
        const kernelPreloads = kernel?.preloadUris.map(uri => uri.toString()) ?? [];

        const staticPreloads = this.notebookRendererRegistry.staticNotebookPreloads
            .filter(preload => preload.type === this.notebook.viewType)
            .map(preload => preload.entrypoint);
        return kernelPreloads.concat(staticPreloads);
    }

    private async createWebviewContent(): Promise<string> {
        const isWorkspaceTrusted = await this.workspaceTrustService.getWorkspaceTrust();
        const preloads = this.preloadsScriptString(isWorkspaceTrusted);
        const content = `
                <html>
                    <head>
                        <meta charset="UTF-8">
                    </head>
                    <body>
                        <script type="module">${preloads}</script>
                    </body>
                </html>
                `;
        return content;
    }

    private preloadsScriptString(isWorkspaceTrusted: boolean): string {
        const ctx: PreloadContext = {
            isWorkspaceTrusted,
            rendererData: this.notebookRendererRegistry.notebookRenderers,
            renderOptions: { // TODO these should be changeable in the settings
                lineLimit: 30,
                outputScrolling: false,
                outputWordWrap: false,
            },
            staticPreloadsData: this.getPreloads()
        };
        // TS will try compiling `import()` in webviewPreloads, so use a helper function instead
        // of using `import(...)` directly
        return `
            const __import = (x) => import(x);
                (${outputWebviewPreload})(JSON.parse(decodeURIComponent("${encodeURIComponent(JSON.stringify(ctx))}")))`;
    }

    dispose(): void {
        this.toDispose.dispose();
        this.outputPresentationListeners.dispose();
        this.webviewWidget.dispose();
    }
}
