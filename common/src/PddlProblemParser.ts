/* --------------------------------------------------------------------------------------------
* Copyright (c) Jan Dolejsi. All rights reserved.
* Licensed under the MIT License. See License.txt in the project root for license information.
* ------------------------------------------------------------------------------------------ */
'use strict';

import { ProblemParserPreProcessor } from "./ProblemParserPreProcessor";
import { dirname } from "path";
import { Util } from "./util";
import { DocumentPositionResolver } from "./DocumentPositionResolver";
import { PddlSyntaxTree } from "./PddlSyntaxTree";
import { ParsingProblem, stripComments } from "./FileInfo";
import { PreProcessingError, PreProcessor } from "./PreProcessors";
import { PddlExtensionContext } from "./PddlExtensionContext";
import { ProblemInfo, TimedVariableValue, VariableValue, SupplyDemand, UnsupportedVariableValue } from "./ProblemInfo";
import { PddlDomainParser } from "./PddlDomainParser";
import { PddlSyntaxNode } from "./PddlSyntaxNode";
import { PddlTokenType, isOpenBracket } from "./PddlTokenizer";
import { PddlInheritanceParser } from "./PddlInheritanceParser";
import { PddlConstraintsParser } from "./PddlConstraintsParser";

/**
 * Planning Problem parser.
 */
export class PddlProblemParser {

    private problemPreParser: ProblemParserPreProcessor | undefined;
    private problemPattern = /^\s*\(define\s*\(problem\s+(\S+)\s*\)\s*\(:domain\s+(\S+)\s*\)/gi;

    constructor(context?: PddlExtensionContext) {
        if (context) {
            this.problemPreParser = new ProblemParserPreProcessor(context);
        }
    }

    async parse(fileUri: string, fileVersion: number, fileText: string, syntaxTree: PddlSyntaxTree, positionResolver: DocumentPositionResolver): Promise<ProblemInfo | undefined> {
        let filePath = Util.fsPath(fileUri);
        let workingDirectory = dirname(filePath);
        let preProcessor: PreProcessor | undefined;

        if (this.problemPreParser) {
            try {
                preProcessor = this.problemPreParser.createPreProcessor(fileText);
                fileText = await this.problemPreParser.process(preProcessor!, fileText, workingDirectory);
            } catch (ex) {
                let problemInfo = new ProblemInfo(fileUri, fileVersion, "unknown", "unknown", PddlSyntaxTree.EMPTY, positionResolver);
                problemInfo.setText(fileText);
                if (ex instanceof PreProcessingError) {
                    let parsingError = <PreProcessingError>ex;
                    problemInfo.addProblems([new ParsingProblem(parsingError.message, parsingError.line, parsingError.column)]);
                }
                else {
                    let line = positionResolver.resolveToPosition(preProcessor?.metaDataLineOffset || 0).line;
                    problemInfo.addProblems([new ParsingProblem(ex.message || ex, line, 0)]);
                }
                if (preProcessor) { problemInfo.setPreParsingPreProcessor(preProcessor); }
                return problemInfo;
            }
        }

        let pddlText = stripComments(fileText);

        this.problemPattern.lastIndex = 0;
        let matchGroups = this.problemPattern.exec(pddlText);

        if (matchGroups) {
            let problemName = matchGroups[1];
            let domainName = matchGroups[2];

            let problemInfo = new ProblemInfo(fileUri, fileVersion, problemName, domainName, syntaxTree, positionResolver);
            problemInfo.setText(fileText);
            this.getProblemStructure(problemInfo);
            if (preProcessor) { problemInfo.setPreParsingPreProcessor(preProcessor); }
            return problemInfo;
        }
        else {
            return undefined;
        }
    }

    getProblemStructure(problemInfo: ProblemInfo): void {
        let defineNode = problemInfo.syntaxTree.getDefineNodeOrThrow();
        PddlDomainParser.parseRequirements(defineNode, problemInfo);

        let objectsNode = defineNode.getFirstOpenBracket(':objects');
        if (objectsNode) {
            let objectsText = objectsNode.getNestedNonCommentText();
            problemInfo.setObjects(PddlInheritanceParser.toTypeObjects(PddlInheritanceParser.parseInheritance(objectsText)));
        }

        let initNode = defineNode.getFirstOpenBracket(':init');
        if (initNode) {
            const [values, supplyDemands] = this.parseInitSection(initNode);
            problemInfo.setInits(values);
            problemInfo.setSupplyDemands(supplyDemands);
        }

        let constraintsNode = defineNode.getFirstOpenBracket(':constraints');
        if (constraintsNode) {
            const constraints = new PddlConstraintsParser().parseConstraints(constraintsNode);
            problemInfo.setConstraints(constraints);
        }
    }

    /**
     * Parses problem :init section.
     * @param initNode init syntax node
     */
    parseInitSection(initNode: PddlSyntaxNode): [TimedVariableValue[], SupplyDemand[]] {
        let timedVariableValues = initNode.getChildren()
            .filter(node => isOpenBracket(node.getToken()))
            .filter(node => node.getToken().tokenText.match(/\(\s*supply-demand/i) === null)
            .map(bracket => this.parseInit(bracket))
            .filter(init => !!init).map(init => init!);

        let supplyDemands = initNode.getChildrenOfType(PddlTokenType.OpenBracketOperator, /\(\s*supply-demand/i)
            .map(bracket => this.parseSupplyDemand(bracket))
            .filter(sd => !!sd).map(sd => sd!);

        return [timedVariableValues, supplyDemands];
    }

    parseInit(bracket: PddlSyntaxNode): TimedVariableValue | undefined {

        if (bracket.getToken().tokenText === '(at') {
            let tokens = bracket.getNonWhitespaceChildren()
                .filter(n => n.isNotType(PddlTokenType.Comment));

            if (tokens.length > 1) {
                let time = parseFloat(tokens[0].getText());
                if (!Number.isNaN(time)) {
                    let variableValue = this.parseVariableValue(tokens[1]);
                    if (variableValue) {
                        return TimedVariableValue.from(time, variableValue);
                    }
                }
            }
        }

        let variableValue = this.parseVariableValue(bracket);
        if (variableValue) {
            return TimedVariableValue.from(0, variableValue);
        }

        return undefined;
    }

    parseVariableValue(node: PddlSyntaxNode): VariableValue | undefined {
        if (node === undefined) {
            return undefined;
        }
        else if (node.getToken().tokenText === '(=') {
            let tokens = node.getNonWhitespaceChildren()
                .filter(n => n.isNotType(PddlTokenType.Comment));

            if (tokens.length > 1) {
                if (tokens[0].isType(PddlTokenType.OpenBracket) && tokens[1].isType(PddlTokenType.Other)) {
                    let variableName = tokens[0].getNestedText();
                    let value = parseFloat(tokens[1].getText());
                    return new VariableValue(variableName, value);
                }
            }
            return undefined;
        }
        else if (node.getToken().tokenText === '(not') {
            let nested = node.getFirstChild(PddlTokenType.OpenBracket, /.*/) ?? node.getFirstChild(PddlTokenType.OpenBracketOperator, /.*/);
            if (!nested) {
                return undefined;
            }
            else {
                return this.parseVariableValue(nested)?.negate();
            }
        }
        else if (['(forall', '(assign', '(increase', '(decrease'].includes(node.getToken().tokenText)) {
            return new UnsupportedVariableValue(node.getText());
        }
        else {
            if (node.getChildren().some(child => isOpenBracket(child.getToken()))) { return undefined; }
            const variableName = node.getToken().tokenText.substr(1) + node.getNestedText();
            return new VariableValue(variableName, true);
        }
    }

    parseSupplyDemand(node: PddlSyntaxNode): SupplyDemand | undefined {
        let tokens = node.getNonWhitespaceChildren();
        if (tokens.length > 0 && tokens[0].isType(PddlTokenType.Other)) {
            return new SupplyDemand(tokens[0].getText());
        }
        else {
            return undefined;
        }
    }

}