DROP INDEX optimization_articles_narrative_idx;
CREATE UNIQUE INDEX optimization_articles_narrative_idx ON optimization_articles(narrative_run_id,recommendation_index)
 WHERE narrative_run_id IS NOT NULL AND deleted_at IS NULL;

INSERT INTO permissions(key,kind,group_label,label,parent_key,navigation_key,icon_key,position,built_in) VALUES
 ('page.customer_knowledge','page','内容与整改','客户知识资产',NULL,'customerKnowledge','book',95,true),
 ('page.publications','page','交付与复测','发布工作台',NULL,'publications','route',96,true),
 ('knowledge.assets.manage','action','客户知识资产','维护客户知识资料','page.customer_knowledge',NULL,NULL,97,true),
 ('knowledge.assets.review','action','客户知识资产','审核客户知识资料','page.customer_knowledge',NULL,NULL,98,true),
 ('publications.channels.manage','action','发布交付','管理发布渠道','page.publications',NULL,NULL,99,true),
 ('publications.manage','action','发布交付','管理发布工单','page.publications',NULL,NULL,100,true),
 ('publications.execute','action','发布交付','执行发布与提交回执','page.publications',NULL,NULL,101,true),
 ('publications.review','action','发布交付','复核发布回执','page.publications',NULL,NULL,102,true),
 ('articles.quality.run','action','文章质检','生成文章质检','page.articles',NULL,NULL,103,true),
 ('articles.quality.review','action','文章质检','复核文章质检','page.articles',NULL,NULL,104,true),
 ('articles.review','action','文章质检','审核文章版本','page.articles',NULL,NULL,105,true);

-- New capabilities require explicit grants; existing revoked permissions are not restored.
UPDATE permissions SET group_label='监测与诊断' WHERE key IN ('page.overview','page.monitor','page.evidence','page.audit','page.diagnosis');
UPDATE permissions SET group_label='内容与整改' WHERE key IN ('page.remediation','page.articles');
UPDATE permissions SET group_label='交付与复测' WHERE key IN ('page.attribution','page.report');

INSERT INTO authorization_policies(id,policy_key,kind,label,http_method,path_pattern,all_of,resource_type,resource_param,scope,built_in)
SELECT 'http:content:'||ordinal,method||' '||path,'http',label,method,path,requirements::jsonb,resource,param,'project',true
FROM (VALUES
 ('01','GET','/api/projects/:projectId/knowledge-assets','客户知识列表','["page.customer_knowledge"]','project','projectId'),
 ('02','POST','/api/projects/:projectId/knowledge-assets','创建客户知识','["page.customer_knowledge","knowledge.assets.manage"]','project','projectId'),
 ('03','GET','/api/knowledge-assets/:assetId','客户知识详情','["page.customer_knowledge"]','knowledge_asset','assetId'),
 ('04','PUT','/api/knowledge-assets/:assetId','更新客户知识','["page.customer_knowledge","knowledge.assets.manage"]','knowledge_asset','assetId'),
 ('05','POST','/api/knowledge-assets/:assetId/review','审核客户知识','["page.customer_knowledge","knowledge.assets.review"]','knowledge_asset','assetId'),
 ('06','GET','/api/projects/:projectId/publication-channels','渠道列表','["page.publications"]','project','projectId'),
 ('07','POST','/api/projects/:projectId/publication-channels','创建渠道','["page.publications","publications.channels.manage"]','project','projectId'),
 ('08','PUT','/api/publication-channels/:channelId','更新渠道','["page.publications","publications.channels.manage"]','publication_channel','channelId'),
 ('09','GET','/api/projects/:projectId/publications','发布工单列表','["page.publications"]','project','projectId'),
 ('10','POST','/api/projects/:projectId/publications','创建发布工单','["page.publications","publications.manage"]','project','projectId'),
 ('11','GET','/api/projects/:projectId/publication-assignees','可选执行人','["page.publications"]','project','projectId'),
 ('12','GET','/api/publications/:orderId','发布工单详情','["page.publications"]','publication_order','orderId'),
 ('13','PUT','/api/publications/:orderId','更新工单计划','["page.publications","publications.manage"]','publication_order','orderId'),
 ('14','POST','/api/publications/:orderId/transition','推进发布工单','["page.publications"]','publication_order','orderId'),
 ('15','GET','/api/articles/:articleId/quality','文章质检与审核历史','["page.articles"]','article','articleId'),
 ('16','POST','/api/articles/:articleId/quality','生成文章质检','["page.articles","articles.quality.run"]','article','articleId'),
 ('17','POST','/api/article-quality/:qualityId/review','复核文章质检','["page.articles","articles.quality.review"]','article_quality','qualityId'),
 ('18','POST','/api/articles/:articleId/review','审核文章版本','["page.articles","articles.review"]','article','articleId'),
 ('19','GET','/api/projects/:projectId/articles/export','批量导出文章','["page.articles"]','project','projectId'),
 ('20','GET','/api/projects/:projectId/operations','客户运营总览','["page.overview"]','project','projectId')
) AS routes(ordinal,method,path,label,requirements,resource,param);
INSERT INTO authorization_policies(id,policy_key,kind,label,all_of,resource_type,scope,built_in)
SELECT 'execution:'||key,key,'execution',label,jsonb_build_array(key),'project','project',true
FROM permissions WHERE key IN ('knowledge.assets.manage','knowledge.assets.review','publications.channels.manage','publications.manage','publications.execute','publications.review','articles.quality.run','articles.quality.review','articles.review');
INSERT INTO authorization_policies(id,policy_key,kind,label,all_of,resource_type,scope,built_in)
VALUES('execution:knowledge.assets.read','knowledge.assets.read','execution','读取客户知识资料','["page.customer_knowledge"]','project','project',true);
