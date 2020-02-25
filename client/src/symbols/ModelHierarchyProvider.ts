/* --------------------------------------------------------------------------------------------
 * Copyright (c) Jan Dolejsi 2019. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';
import { HoverProvider, TextDocument, Position, CancellationToken, Hover, MarkdownString, ExtensionContext, window, TextEditor, Range, TextEditorDecorationType, Location, CallHierarchyProvider, CallHierarchyItem, SymbolKind, ProviderResult, CallHierarchyIncomingCall, CallHierarchyOutgoingCall, workspace } from 'vscode';
import { SymbolUtils, VariableInfo, SymbolInfo } from './SymbolUtils';
import { CodePddlWorkspace } from '../workspace/CodePddlWorkspace';
import { ModelHierarchy, VariableReferenceInfo, VariableReferenceKind, VariableEffectReferenceInfo } from '../../../common/src/ModelHierarchy';
import { PDDL } from '../../../common/src/parser';
import { DomainInfo, PddlDomainConstruct } from '../../../common/src/DomainInfo';
import { Variable } from '../../../common/src/FileInfo';
import { toPosition, toRange, nodeToRange } from '../utils';
import { isPddl } from '../workspace/workspaceUtils';
import { IncreaseEffect, AssignEffect, DecreaseEffect, MakeTrueEffect, MakeFalseEffect, ScaleDownEffect, ScaleUpEffect } from '../../../common/src/ActionEffectParser';
import { PddlWorkspace } from '../../../common/src/PddlWorkspace';
import { Util } from '../../../common/src/util';

export class ModelHierarchyProvider implements HoverProvider, CallHierarchyProvider {
    private symbolUtils: SymbolUtils;
    private dirtyEditors = new Set<TextEditor>();
    private timeout: NodeJS.Timer | undefined = undefined;
    private decorations = new Map<TextEditor, TextEditorDecorationType[]>();

    constructor(context: ExtensionContext, private readonly pddlWorkspace: CodePddlWorkspace) {
        this.symbolUtils = new SymbolUtils(pddlWorkspace);
        window.onDidChangeActiveTextEditor(editor => this.scheduleDecoration(editor), null, context.subscriptions);
        pddlWorkspace.pddlWorkspace.on(PddlWorkspace.UPDATED, updatedFile => {
            if (updatedFile instanceof DomainInfo) {
                window.visibleTextEditors
                    .filter(editor => editor.document.uri.toString() === updatedFile.fileUri)
                    .forEach(editor => this.scheduleDecoration(editor));
            }
        });
        window.visibleTextEditors.forEach(editor => this.scheduleDecoration(editor));
    }

    async prepareCallHierarchy(document: TextDocument, position: Position, token: CancellationToken): Promise<CallHierarchyItem | undefined> {
        if (token.isCancellationRequested) { return undefined; }
        await this.symbolUtils.assertFileParsed(document);

        let symbolInfo = this.symbolUtils.getSymbolInfo(document, position);

        if (symbolInfo instanceof VariableInfo) {
            return new VariableCallHierarchyItem(<VariableInfo>symbolInfo, document);
        } else {
            return undefined;
        }
    }

    async provideCallHierarchyIncomingCalls(item: CallHierarchyItem, token: CancellationToken): Promise<CallHierarchyIncomingCall[] | undefined> {
        if (token.isCancellationRequested) { return undefined; }
        let document = await workspace.openTextDocument(item.uri);
        let fileInfo = this.pddlWorkspace.getFileInfoByUri(item.uri);

        if (!fileInfo) {
            console.log(`File not found in the workspace: ${item.uri}`);
            return undefined;
        }

        if (!fileInfo.isDomain()) {
            console.log(`File is not a PDDL domain: ${fileInfo.fileUri}`);
            return undefined;
        }

        let domainInfo = <DomainInfo>fileInfo;

        if (item instanceof VariableCallHierarchyItem) {
            let variableItem = <VariableCallHierarchyItem>item;
            let references = this.symbolUtils.findSymbolReferences(document, variableItem.variableInfo, false);
            let pddlFileInfo = this.pddlWorkspace.getFileInfo(document);
            if (!pddlFileInfo) { return undefined; }

            if (references !== undefined && domainInfo !== undefined) {
                let referenceInfos = this.getReferences(references, domainInfo, variableItem.variableInfo, document);

                /*
                let readReferences = referenceInfos
                    .filter(ri => [VariableReferenceKind.READ, VariableReferenceKind.READ_OR_WRITE].includes(ri.kind));

                const writeReferences = referenceInfos
                    .filter(ri => [VariableReferenceKind.WRITE, VariableReferenceKind.READ_OR_WRITE].includes(ri.kind));
                const writeEffectReferences = writeReferences
                    .filter(ri => (ri instanceof VariableEffectReferenceInfo))
                    .map(ri => <VariableEffectReferenceInfo>ri);

                let increaseReferences = writeEffectReferences.filter(ri => ri.effect instanceof IncreaseEffect);
                let decreaseReferences = writeEffectReferences.filter(ri => ri.effect instanceof DecreaseEffect);
                let scaleUpReferences = writeEffectReferences.filter(ri => ri.effect instanceof ScaleUpEffect);
                let scaleDownReferences = writeEffectReferences.filter(ri => ri.effect instanceof ScaleDownEffect);
                let assignReferences = writeEffectReferences.filter(ri => ri.effect instanceof AssignEffect);
                let makeTrueReferences = writeEffectReferences.filter(ri => ri.effect instanceof MakeTrueEffect);
                let makeFalseReferences = writeEffectReferences.filter(ri => ri.effect instanceof MakeFalseEffect);
*/
                let referenceByStructure = Util.groupBy(referenceInfos, vri => vri.structure);

                return [...referenceByStructure.keys()]
                    .map(structure => this.createVariableIncomingCall(document, structure, referenceByStructure.get(structure)!));
            }
        } else if (item instanceof StructureCallHierarchyItem) {
            // let structure = (<StructureCallHierarchyItem>item).structure;
            return undefined;
        }

        return undefined;
    }

    private createVariableIncomingCall(document: TextDocument, structure: PddlDomainConstruct, references: VariableReferenceInfo[]): CallHierarchyIncomingCall {
        let structureItem = new StructureCallHierarchyItem(structure, document);
        let referenceRanges = references.map(ref => nodeToRange(document, ref.node));
        return new CallHierarchyIncomingCall(structureItem, referenceRanges);
    }

    provideCallHierarchyOutgoingCalls(_item: CallHierarchyItem, _token: CancellationToken): ProviderResult<CallHierarchyOutgoingCall[]> {
        throw new Error("Method not implemented.");
    }

    scheduleDecoration(editor: TextEditor | undefined): void {
        if (editor && editor.visibleRanges.length && isPddl(editor.document)) {

            this.triggerDecorationRefresh(editor);
        }
    }

    private triggerDecorationRefresh(editor: TextEditor): void {
        this.dirtyEditors.add(editor);
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = undefined;
        }
        this.timeout = setTimeout(() => this.refreshDirtyEditors(), 1000);
    }

    private refreshDirtyEditors(): void {
        let currentlyDirtyEditors = new Set<TextEditor>(this.dirtyEditors);
        this.dirtyEditors.clear();

        currentlyDirtyEditors
            .forEach(editor => this.updateDecoration(editor));
    }

    private updateDecoration(editor: TextEditor): void {
        if (editor.visibleRanges.length === 0) { return; }
        let fileInfo = this.pddlWorkspace.pddlWorkspace.getFileInfo(editor.document.uri.toString());

        if (fileInfo instanceof DomainInfo) {
            let domainInfo = <DomainInfo>fileInfo;

            let allVariables = domainInfo.getFunctions().concat(domainInfo.getPredicates());
            //todo: add derived variables

            this.decorations.get(editor)?.forEach(d => d.dispose());
            this.decorations.delete(editor);

            let decorations = allVariables.map(v => this.decorateVariable(v, editor, domainInfo))
                .filter(dec => !!dec)
                .map(dec => dec!);

            this.decorations.set(editor, decorations);
        }
    }

    decorateVariable(variable: Variable, editor: TextEditor, domainInfo: DomainInfo): TextEditorDecorationType | undefined {
        let symbolInfo = this.symbolUtils.getSymbolInfo(editor.document, toPosition(variable.getLocation().start).translate({ characterDelta: 1 }));

        if (symbolInfo instanceof VariableInfo) {
            let references = this.symbolUtils.findSymbolReferences(editor.document, symbolInfo, false);
            let pddlFileInfo = this.pddlWorkspace.getFileInfo(editor.document);
            if (!pddlFileInfo) { return undefined; }

            if (references !== undefined && domainInfo !== undefined) {
                let referenceInfos = this.getReferences(references, domainInfo, symbolInfo, editor.document);

                let readCount = referenceInfos
                    .filter(ri => [VariableReferenceKind.READ, VariableReferenceKind.READ_OR_WRITE].includes(ri.kind))
                    .length;

                const writeReferences = referenceInfos
                    .filter(ri => [VariableReferenceKind.WRITE, VariableReferenceKind.READ_OR_WRITE].includes(ri.kind));
                const writeEffectReferences = writeReferences
                    .filter(ri => (ri instanceof VariableEffectReferenceInfo))
                    .map(ri => <VariableEffectReferenceInfo>ri);

                let increaseCount = writeEffectReferences.filter(ri => ri.effect instanceof IncreaseEffect).length;
                let decreaseCount = writeEffectReferences.filter(ri => ri.effect instanceof DecreaseEffect).length;
                let scaleUpCount = writeEffectReferences.filter(ri => ri.effect instanceof ScaleUpEffect).length;
                let scaleDownCount = writeEffectReferences.filter(ri => ri.effect instanceof ScaleDownEffect).length;
                let assignCount = writeEffectReferences.filter(ri => ri.effect instanceof AssignEffect).length;
                let makeTrueCount = writeEffectReferences.filter(ri => ri.effect instanceof MakeTrueEffect).length;
                let makeFalseCount = writeEffectReferences.filter(ri => ri.effect instanceof MakeFalseEffect).length;

                var decorationText: string[] = [];
                var hoverText: string[] = [];

                if (readCount) {
                    decorationText.push(`${readCount}👁`);
                    hoverText.push(`${readCount}x read`);
                }

                if (increaseCount) {
                    decorationText.push(`${increaseCount}↗`);
                    hoverText.push(`${increaseCount}x increased`);
                }

                if (decreaseCount) {
                    decorationText.push(`${decreaseCount}↘`);
                    hoverText.push(`${decreaseCount}x decreased`);
                }

                if (scaleUpCount) {
                    decorationText.push(`${scaleUpCount}⤴`);
                    hoverText.push(`${scaleUpCount}x scaled up`);
                }

                if (scaleDownCount) {
                    decorationText.push(`${scaleDownCount}⤵`);
                    hoverText.push(`${scaleDownCount}x scaled down`);
                }

                if (assignCount) {
                    decorationText.push(`${assignCount}≔`);
                    hoverText.push(`${assignCount}x assigned`);
                }

                if (makeTrueCount) {
                    decorationText.push(`${makeTrueCount}☑`);// ⊨
                    hoverText.push(`${makeTrueCount}x made true`);
                }
                if (makeFalseCount) {
                    decorationText.push(`${makeFalseCount}☒`);// ⊭ 
                    hoverText.push(`${makeFalseCount}x made false`);
                }

                const rest = referenceInfos.length - readCount - increaseCount - decreaseCount - scaleUpCount - scaleDownCount - assignCount - makeTrueCount - makeFalseCount;

                if (rest) {
                    decorationText.push(`${rest}?`);
                    hoverText.push(`${rest}x unrecognized`);
                }

                return this.decorate(editor, decorationText.join(' '), hoverText.join('\n\n'), symbolInfo.location.range);
            }

        }

        return undefined;
    }

    decorate(editor: TextEditor, decorationText: string, hoverText: string, range: Range): TextEditorDecorationType {
        let decorationType = window.createTextEditorDecorationType({
            after: {
                contentText: decorationText,
                textDecoration: "; color: gray; margin-left: 10px" //font-size: 10px; ; opacity: 0.5
            }
        });
        editor.setDecorations(decorationType, [{ range: range, hoverMessage: hoverText }]);
        return decorationType;
    }

    async provideHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover | undefined> {
        if (token.isCancellationRequested) { return undefined; }
        await this.symbolUtils.assertFileParsed(document);

        let symbolInfo = this.symbolUtils.getSymbolInfo(document, position);

        if (symbolInfo instanceof VariableInfo) {
            let references = this.symbolUtils.findSymbolReferences(document, symbolInfo, false);
            let pddlFileInfo = this.pddlWorkspace.getFileInfo(document);
            if (!pddlFileInfo) { return undefined; }
            let domainInfo = this.pddlWorkspace.pddlWorkspace.asDomain(pddlFileInfo);

            if (references !== undefined && domainInfo !== undefined) {
                let referenceInfos = this.getReferences(references, domainInfo, symbolInfo, document);

                let documentation = this.createReferenceDocumentation(referenceInfos);

                return new Hover(documentation, symbolInfo.hover.range);
            }
            else {
                return undefined;
            }

        } else {
            return undefined;
        }
    }


    private getReferences(references: Location[], domainInfo: DomainInfo, symbolInfo: SymbolInfo, document: TextDocument): VariableReferenceInfo[] {
        return references
            .filter(r => r.uri.toString() === domainInfo.fileUri) // limit this to the domain file only
            .map(r => new ModelHierarchy(domainInfo!).getReferenceInfo((<VariableInfo>symbolInfo).variable, document.offsetAt(r.range.start) + 1));
    }

    private createReferenceDocumentation(referenceInfos: VariableReferenceInfo[]) {
        let documentation = new MarkdownString(`**References**\n`);

        this.addAccessKindDocumentation(documentation, referenceInfos, 'Read', VariableReferenceKind.READ);
        this.addAccessKindDocumentation(documentation, referenceInfos, 'Write', VariableReferenceKind.WRITE);
        this.addAccessKindDocumentation(documentation, referenceInfos, 'Read or write', VariableReferenceKind.READ_OR_WRITE);
        this.addAccessKindDocumentation(documentation, referenceInfos, 'Unrecognized', VariableReferenceKind.UNRECOGNIZED);

        if (referenceInfos.length === 0) {
            documentation.appendText('\nNo references.');
        }

        return documentation;
    }

    private addAccessKindDocumentation(documentation: MarkdownString, referenceInfos: VariableReferenceInfo[], label: string, kind: VariableReferenceKind) {
        const accessReferences = referenceInfos.filter(ri => ri.kind === kind);
        if (accessReferences.length > 0) {
            documentation.appendText('\n' + label + ' access:\n');
            this.createAccessKindDocumentation(accessReferences, documentation);
        }
    }

    private createAccessKindDocumentation(referenceInfos: VariableReferenceInfo[], documentation: MarkdownString): void {
        referenceInfos.forEach(ri => documentation.appendMarkdown(`\n- \`${ri.structure.getNameOrEmpty()}\` ${ri.getTimeQualifier()} ${ri.part}`).appendCodeblock(ri.relevantCode ?? '', PDDL));
    }
}

class VariableCallHierarchyItem extends CallHierarchyItem {

    /**
     * Creates a new predicate/function call hierarchy item.
     */
    constructor(public readonly variableInfo: VariableInfo, document: TextDocument) {
        super(SymbolKind.Function,
            `(${variableInfo.variable.getFullName()})`,
            variableInfo.hover.contents.join(''),
            document.uri,
            variableInfo.location.range,
            variableInfo.location.range);
    }
}

class StructureCallHierarchyItem extends CallHierarchyItem {
    constructor(public readonly structure: PddlDomainConstruct, document: TextDocument) {
        super(SymbolKind.Method, structure.getNameOrEmpty(), structure.getDocumentation().join(), document.uri, toRange(structure.getLocation()), toRange(structure.getLocation()));
    }
}