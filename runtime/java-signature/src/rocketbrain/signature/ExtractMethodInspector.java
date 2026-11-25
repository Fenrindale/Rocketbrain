package rocketbrain.signature;

import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.util.*;
import javax.lang.model.element.*;
import javax.lang.model.type.*;
import javax.lang.model.util.Elements;
import static rocketbrain.signature.SignatureInspector.object;

/** Proves a statement sequence and the exact call replacing it using attributed source. */
final class ExtractMethodInspector {
    private final Trees trees;
    private final Elements elements;
    private final SourcePositions positions;
    private final CompilationUnitTree unit;
    private final String text;

    ExtractMethodInspector(JavacTask task, CompilationUnitTree unit, String text) {
        trees = Trees.instance(task);
        elements = task.getElements();
        positions = trees.getSourcePositions();
        this.unit = unit;
        this.text = text;
    }

    private int start(Tree tree) { return (int)positions.getStartPosition(unit,tree); }
    private int end(Tree tree) { return (int)positions.getEndPosition(unit,tree); }
    private String source(Tree tree) { return text.substring(start(tree),end(tree)); }
    private Map<String,Object> error(String reason) { return object("error",reason); }

    Map<String,Object> inspect(int from, int to, String name, int callOffset) {
        List<TreePath> paths = new ArrayList<>();
        new TreePathScanner<Void,Void>() {
            @Override public Void visitMethod(MethodTree method, Void unused) {
                if (method.getBody()!=null && start(method.getBody())<from && to<end(method.getBody())) paths.add(getCurrentPath());
                return super.visitMethod(method,unused);
            }
        }.scan(unit,null);
        if (paths.size()!=1) return error("Select complete statements in one ordinary named Java method.");
        TreePath path = paths.getFirst();
        MethodTree method = (MethodTree)path.getLeaf();
        if (!(trees.getElement(path) instanceof ExecutableElement declaration) || declaration.getKind()!=ElementKind.METHOD ||
            !(declaration.getEnclosingElement() instanceof TypeElement owner) || owner.getKind()!=ElementKind.CLASS ||
            !Set.of(NestingKind.TOP_LEVEL,NestingKind.MEMBER).contains(owner.getNestingKind())) {
            return error("Select a method in an ordinary named Java class.");
        }
        Selection selection = selection(path,method,from,to);
        if (selection==null) return error("Select complete trailing statements or a contiguous sequence in one Java block.");
        var selected = selection.statements();
        boolean returnsValue = selection.endsMethod() && selected.getLast() instanceof ReturnTree returned &&
            returned.getExpression()!=null;
        if (returnsValue && selected.size()<2) return error("Select at least two complete trailing statements ending with a return value.");
        if (callOffset<0 && nameUsed(owner,name)) return error("Choose a new method name unused in the current Java source and its hierarchy.");
        boolean voidMethod = declaration.getReturnType().getKind()==TypeKind.VOID;
        boolean outputHelper = callOffset>=0 && !returnsValue && !voidMethod;
        var methodStatements = method.getBody().getStatements();
        if (callOffset>=0 && (!declaration.getSimpleName().contentEquals(name) ||
            !declaration.getModifiers().contains(Modifier.PRIVATE) || selection.block().getLeaf()!=method.getBody() ||
            selected.getFirst()!=methodStatements.getFirst() || selected.size()+(outputHelper?1:0)!=methodStatements.size() ||
            returnsValue && voidMethod)) {
            return error("Javac could not verify the generated private helper.");
        }
        BodyProof body = new BodyProof(declaration,from,to,returnsValue);
        for (StatementTree statement : selected) {
            if (body.supports(statement)) body.scan(new TreePath(selection.block(),statement),null);
            else body.invalid=true;
        }
        if (body.invalid) return error("Use local statements, if, loops or a trailing return. Captured writes, nonlocal control flow, local types and nested lambdas are unsupported.");
        List<VariableElement> outputs = callOffset<0?usedOutside(path,body.locals.keySet(),from,to):
            outputHelper?returnedLocals(path,declaration,methodStatements.getLast(),body.locals.keySet()):List.of();
        if (outputs==null || outputs.size()>4 || outputs.stream().anyMatch(value->!transferable(value,selection))) {
            return error("A local value used outside the extraction must be an initialized, nonconstant local declared directly in the selection. Use at most four output values.");
        }
        if (callOffset<0 && !outputs.isEmpty()) {
            String resultType=name.substring(0,1).toUpperCase(Locale.ROOT)+name.substring(1)+"Values";
            if (nameUsed(owner,name+"Result") || nameUsed(owner,resultType)) {
                return error("Choose a helper name whose generated result variable and type are unused.");
            }
        }
        Map<String,Object> result = object("owner",owner.getQualifiedName().toString(),"className",owner.getSimpleName().toString(),
            "method",SignatureInspector.key(declaration),"staticMethod",declaration.getModifiers().contains(Modifier.STATIC),
            "methodEnd",end(method),"methodStart",start(method),"start",from,"end",to,"statementCount",selected.size(),
            "returnsValue",returnsValue,"sourceReturn",returnsValue?source(method.getReturnType()):"void",
            "returnType",returnsValue?declaration.getReturnType().toString():"void",
            "sourceTypeParameters",method.getTypeParameters().stream().map(this::source).toList(),
            "typeNames",declaration.getTypeParameters().stream().map(parameter->parameter.getSimpleName().toString()).toList(),
            "sourceThrows",method.getThrows().stream().map(this::source).toList(),
            "throwsTypes",declaration.getThrownTypes().stream().map(Object::toString).toList(),
            "captures",body.captures.keySet().stream().map(this::variable).toList(),"outputs",outputs.stream().map(this::output).toList(),
            "bindings",body.bindings,"selected",selected.stream().map(Object::toString).toList());
        if (callOffset>=0) {
            result.put("parameters",declaration.getParameters().stream().map(this::variable).toList());
            result.put("call",call(callOffset,declaration,returnsValue,outputs));
            if (outputHelper) result.put("outputType",declaration.getReturnType().toString());
        }
        return result;
    }

    private record Selection(TreePath block,List<? extends StatementTree> statements,boolean endsMethod) {}

    private Selection selection(TreePath methodPath,MethodTree method,int from,int to) {
        List<Selection> matches = new ArrayList<>();
        new TreePathScanner<Void,Void>() {
            @Override public Void visitBlock(BlockTree block,Void unused) {
                if (start(block)>=from || end(block)<=to) return null;
                var statements=block.getStatements();
                int first=0;
                while (first<statements.size() && start(statements.get(first))<from) first++;
                int last=first;
                while (last<statements.size() && end(statements.get(last))<=to) last++;
                if (first<last && start(statements.get(first))==from && end(statements.get(last-1))==to) {
                    matches.add(new Selection(getCurrentPath(),statements.subList(first,last),
                        block==method.getBody() && last==statements.size()));
                }
                return super.visitBlock(block,unused);
            }
        }.scan(new TreePath(methodPath,method.getBody()),null);
        return matches.size()==1?matches.getFirst():null;
    }

    private List<VariableElement> usedOutside(TreePath method,Set<VariableElement> locals,int from,int to) {
        if (locals.isEmpty()) return List.of();
        Set<VariableElement> observed = new HashSet<>();
        new TreePathScanner<Void,Void>() {
            @Override public Void visitIdentifier(IdentifierTree tree,Void unused) {
                int offset=start(tree);
                if ((offset<from || offset>=to) && trees.getElement(getCurrentPath()) instanceof VariableElement value &&
                    locals.contains(value)) observed.add(value);
                return super.visitIdentifier(tree,unused);
            }
        }.scan(method,null);
        return locals.stream().filter(observed::contains).toList();
    }

    private boolean transferable(VariableElement value,Selection selection) {
        TreePath declaration=trees.getPath(value);
        return declaration!=null && declaration.getParentPath().getLeaf()==selection.block().getLeaf() &&
            declaration.getLeaf() instanceof VariableTree variable && variable.getInitializer()!=null &&
            variable.getModifiers().getAnnotations().isEmpty() && value.getConstantValue()==null;
    }

    private Map<String,Object> output(VariableElement value) {
        return object("name",value.getSimpleName().toString(),"type",value.asType().toString(),
            "final",value.getModifiers().contains(Modifier.FINAL));
    }

    private List<VariableElement> returnedLocals(TreePath method,ExecutableElement helper,StatementTree statement,
        Set<VariableElement> locals) {
        if (!(helper.getReturnType() instanceof DeclaredType returnType) || !(returnType.asElement() instanceof TypeElement record) ||
            record.getKind()!=ElementKind.RECORD || !(statement instanceof ReturnTree returned) ||
            !(returned.getExpression() instanceof NewClassTree created) || created.getClassBody()!=null) return null;
        TreePath at=new TreePath(new TreePath(new TreePath(method,((MethodTree)method.getLeaf()).getBody()),returned),created);
        if (!helper.getReturnType().toString().equals(trees.getTypeMirror(at).toString())) return null;
        List<VariableElement> outputs = new ArrayList<>();
        for (ExpressionTree argument : created.getArguments()) {
            if (!(argument instanceof IdentifierTree) ||
                !(trees.getElement(new TreePath(at,argument)) instanceof VariableElement value) ||
                !locals.contains(value) || outputs.contains(value)) return null;
            outputs.add(value);
        }
        return outputs.isEmpty()?null:outputs;
    }

    private Map<String,Object> variable(VariableElement element) {
        TreePath path = trees.getPath(element);
        return object("name",element.getSimpleName().toString(),"type",element.asType().toString(),
            "start",path==null||path.getCompilationUnit()!=unit?-1:start(path.getLeaf()));
    }

    private boolean nameUsed(TypeElement owner, String name) {
        if (elements.getAllMembers(owner).stream().anyMatch(member->member instanceof ExecutableElement method &&
            method.getSimpleName().contentEquals(name))) return true;
        boolean[] used = {false};
        new TreeScanner<Void,Void>() {
            @Override public Void visitIdentifier(IdentifierTree tree,Void unused) {
                used[0]|=tree.getName().contentEquals(name);return super.visitIdentifier(tree,unused);
            }
            @Override public Void visitMemberSelect(MemberSelectTree tree,Void unused) {
                used[0]|=tree.getIdentifier().contentEquals(name);return super.visitMemberSelect(tree,unused);
            }
            @Override public Void visitMemberReference(MemberReferenceTree tree,Void unused) {
                used[0]|=tree.getName().contentEquals(name);return super.visitMemberReference(tree,unused);
            }
        }.scan(unit,null);
        return used[0];
    }

    private Map<String,Object> call(int offset,ExecutableElement helper,boolean returnsValue,List<VariableElement> outputs) {
        List<Map<String,Object>> calls = new ArrayList<>();
        new TreePathScanner<Void,Void>() {
            @Override public Void visitMethodInvocation(MethodInvocationTree call, Void unused) {
                TreePath path = getCurrentPath(), parent = path.getParentPath();
                if (start(call)!=offset || !helper.equals(trees.getElement(path))) return super.visitMethodInvocation(call,unused);
                boolean rightStatement=returnsValue?parent.getLeaf() instanceof ReturnTree:
                    outputs.isEmpty()?parent.getLeaf() instanceof ExpressionStatementTree:restoresOutputs(parent,call,helper,outputs);
                if (rightStatement) {
                    List<Map<String,Object>> arguments = new ArrayList<>();
                    for (ExpressionTree expression : call.getArguments()) {
                        if (!(expression instanceof IdentifierTree) ||
                            !(trees.getElement(new TreePath(path,expression)) instanceof VariableElement variable)) return null;
                        arguments.add(variable(variable));
                    }
                    TreePath caller = parent;
                    while (caller!=null && !(caller.getLeaf() instanceof MethodTree)) caller=caller.getParentPath();
                    if (caller!=null && trees.getElement(caller) instanceof ExecutableElement method) {
                        calls.add(object("caller",SignatureInspector.key(method),"arguments",arguments,
                            "type",trees.getTypeMirror(path).toString()));
                    }
                }
                return super.visitMethodInvocation(call,unused);
            }
        }.scan(unit,null);
        return calls.size()==1?calls.getFirst():null;
    }

    private boolean restoresOutputs(TreePath declaration,MethodInvocationTree call,ExecutableElement helper,List<VariableElement> outputs) {
        if (!(declaration.getLeaf() instanceof VariableTree temporary) || temporary.getInitializer()!=call ||
            !(declaration.getParentPath().getLeaf() instanceof BlockTree block) ||
            !(trees.getElement(declaration) instanceof VariableElement result) ||
            !result.asType().toString().equals(helper.getReturnType().toString()) ||
            !(helper.getReturnType() instanceof DeclaredType type)) return false;
        var statements=block.getStatements();
        int first=statements.indexOf(temporary)+1;
        if (first<1 || first+outputs.size()>statements.size()) return false;
        for (int index=0;index<outputs.size();index++) {
            if (!(statements.get(first+index) instanceof VariableTree restored) ||
                !(restored.getInitializer() instanceof MethodInvocationTree accessor) ||
                !accessor.getArguments().isEmpty() || !(accessor.getMethodSelect() instanceof MemberSelectTree select)) return false;
            TreePath variablePath=new TreePath(declaration.getParentPath(),restored);
            TreePath accessorPath=new TreePath(variablePath,accessor);
            TreePath receiver=new TreePath(new TreePath(accessorPath,select),select.getExpression());
            if (!(trees.getElement(variablePath) instanceof VariableElement variable) ||
                !output(outputs.get(index)).equals(output(variable)) || !result.equals(trees.getElement(receiver)) ||
                !(trees.getElement(accessorPath) instanceof ExecutableElement getter) ||
                !getter.getEnclosingElement().equals(type.asElement()) ||
                !getter.getSimpleName().contentEquals("value"+index)) return false;
        }
        return true;
    }

    private final class BodyProof extends TreePathScanner<Void,Void> {
        private static final Set<Tree.Kind> LOOPS = Set.of(Tree.Kind.FOR_LOOP,Tree.Kind.ENHANCED_FOR_LOOP,
            Tree.Kind.WHILE_LOOP,Tree.Kind.DO_WHILE_LOOP);
        private static final Set<Tree.Kind> STATEMENTS = Set.of(Tree.Kind.BLOCK,Tree.Kind.VARIABLE,Tree.Kind.IF,
            Tree.Kind.RETURN,Tree.Kind.THROW,Tree.Kind.EXPRESSION_STATEMENT,Tree.Kind.FOR_LOOP,
            Tree.Kind.ENHANCED_FOR_LOOP,Tree.Kind.WHILE_LOOP,Tree.Kind.DO_WHILE_LOOP,Tree.Kind.BREAK,Tree.Kind.CONTINUE);
        final ExecutableElement method;
        final int from, to;
        final boolean returnsValue;
        final List<String> bindings = new ArrayList<>();
        final Map<VariableElement,Integer> locals = new LinkedHashMap<>(), captures = new LinkedHashMap<>();
        boolean invalid;

        BodyProof(ExecutableElement method,int from,int to,boolean returnsValue) {
            this.method=method;this.from=from;this.to=to;this.returnsValue=returnsValue;
        }

        private boolean supports(Tree tree) {
            boolean unsupportedStatement = tree instanceof StatementTree && !STATEMENTS.contains(tree.getKind());
            return !(unsupportedStatement || tree instanceof ReturnTree && !returnsValue ||
                tree instanceof LambdaExpressionTree || tree instanceof MemberReferenceTree ||
                tree instanceof NewClassTree creation && creation.getClassBody()!=null ||
                tree instanceof BindingPatternTree);
        }

        @Override public Void scan(Tree tree,Void unused) {
            if (tree==null || invalid) return null;
            if (!supports(tree)) {invalid=true;return null;}
            return super.scan(tree,unused);
        }

        @Override public Void visitVariable(VariableTree tree,Void unused) {
            if (trees.getElement(getCurrentPath()) instanceof VariableElement local && local.getKind()==ElementKind.LOCAL_VARIABLE) {
                locals.put(local,locals.size());
                bindings.add("declare:"+local.getSimpleName()+":"+local.asType());
            }
            return super.visitVariable(tree,unused);
        }

        private boolean insideSelectedLoop(boolean breaking) {
            for (TreePath path=getCurrentPath().getParentPath(); path!=null; path=path.getParentPath()) {
                Tree tree=path.getLeaf();
                if (LOOPS.contains(tree.getKind()) || breaking && tree.getKind()==Tree.Kind.SWITCH) {
                    return LOOPS.contains(tree.getKind()) && start(tree)>=from && end(tree)<=to;
                }
                if (tree instanceof MethodTree || tree instanceof LambdaExpressionTree) return false;
            }
            return false;
        }

        @Override public Void visitBreak(BreakTree statement,Void unused) {
            invalid|=statement.getLabel()!=null || !insideSelectedLoop(true);
            return null;
        }

        @Override public Void visitContinue(ContinueTree statement,Void unused) {
            invalid|=statement.getLabel()!=null || !insideSelectedLoop(false);
            return null;
        }

        private boolean written(TreePath path) {
            Tree leaf=path.getLeaf(), parent=path.getParentPath().getLeaf();
            while (parent instanceof ParenthesizedTree) {
                path=path.getParentPath();
                leaf=parent;
                parent=path.getParentPath().getLeaf();
            }
            return parent instanceof AssignmentTree assignment && assignment.getVariable()==leaf ||
                parent instanceof CompoundAssignmentTree compound && compound.getVariable()==leaf ||
                parent instanceof UnaryTree unary && Set.of(Tree.Kind.PREFIX_INCREMENT,Tree.Kind.PREFIX_DECREMENT,
                    Tree.Kind.POSTFIX_INCREMENT,Tree.Kind.POSTFIX_DECREMENT).contains(unary.getKind());
        }

        private void bind() {
            TreePath path = getCurrentPath();
            Element target = trees.getElement(path);
            TypeMirror type = trees.getTypeMirror(path);
            String identity;
            if (path.getLeaf() instanceof IdentifierTree identifier && Set.of("this","super").contains(identifier.getName().toString())) {
                identity=identifier.getName().toString();
            } else if (target instanceof VariableElement local &&
                Set.of(ElementKind.PARAMETER,ElementKind.LOCAL_VARIABLE).contains(local.getKind())) {
                TreePath declaration=trees.getPath(local);
                if (declaration==null || declaration.getCompilationUnit()!=unit || !local.getEnclosingElement().equals(method)) {
                    invalid=true;return;
                }
                int offset=start(declaration.getLeaf());
                if (offset>=from && offset<to && locals.containsKey(local)) identity="local:"+locals.get(local)+":"+local.getSimpleName();
                else if (offset>=0 && offset<from && !written(path) && local.getConstantValue()==null) {
                    captures.putIfAbsent(local,captures.size());
                    identity="capture:"+captures.get(local)+":"+local.getSimpleName();
                } else {invalid=true;return;}
            } else if (target instanceof ExecutableElement executable) identity=SignatureInspector.key(executable);
            else if (target instanceof TypeParameterElement parameter && parameter.getEnclosingElement().equals(method))
                identity="method-type:"+parameter.getSimpleName();
            else if (target instanceof TypeElement resolved) identity=resolved.getQualifiedName().toString();
            else if (target!=null) identity=target.getKind()+":"+target.getEnclosingElement()+":"+target;
            else {invalid=true;return;}
            bindings.add(path.getLeaf().getKind()+":"+identity+":"+type);
        }
        @Override public Void visitIdentifier(IdentifierTree node,Void unused) {bind();return super.visitIdentifier(node,unused);}
        @Override public Void visitMemberSelect(MemberSelectTree node,Void unused) {bind();return super.visitMemberSelect(node,unused);}
        @Override public Void visitMethodInvocation(MethodInvocationTree node,Void unused) {bind();return super.visitMethodInvocation(node,unused);}
        @Override public Void visitNewClass(NewClassTree node,Void unused) {bind();return super.visitNewClass(node,unused);}
    }
}
